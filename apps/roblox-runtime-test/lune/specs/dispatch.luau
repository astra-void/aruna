--!nocheck
-- The native runtime calls handlers as methods (`definition:run(context, input)`),
-- so each `run` here takes a leading self parameter, exactly as roblox-ts emits
-- for `defineAction({ run(context, input) {} })`.
local roblox = require("@lune/roblox")
return function(ctx)
	local t = ctx.t
	local Promise = ctx.Promise
	local schema = ctx.load("schema").schema
	local createActionRegistry = ctx.load("server-runtime").createActionRegistry

	local player = { UserId = 1, Name = "Tester" }

	t.describe("server dispatch", function()
		t.it("resolves with an error payload for unknown actions", function()
			local r = createActionRegistry({})
			local settled, ok, value = t.await(r.dispatch(player, "missing", {}))
			t.isTrue(settled, "dispatch settled")
			t.isTrue(ok, "dispatch resolves rather than rejecting")
			t.isFalse(value.ok)
			t.contains(value.error, "Aruna action not found: missing")
			t.eq(value.errorName, "ActionNotFoundError")
		end)

		t.it("returns the action output on success", function()
			local r = createActionRegistry({
				echo = {
					id = "echo",
					run = function(_self, _context, input)
						return { value = input.value }
					end,
				},
			})
			local _, _, value = t.await(r.dispatch(player, "echo", { value = 7 }))
			t.isTrue(value.ok)
			t.eq(value.output.value, 7)
		end)

		t.it("runs middleware outermost-first around the handler", function()
			local order = {}
			local r = createActionRegistry({
				echo = {
					id = "echo",
					run = function(_self, _context, input)
						table.insert(order, "run")
						return { value = input.value }
					end,
				},
			}, {
				middleware = {
					function(info, nextInvoke)
						table.insert(order, "outer:" .. info.actionId)
						return nextInvoke():andThen(function(output)
							table.insert(order, "outer:done")
							return output
						end)
					end,
					function(_info, nextInvoke)
						table.insert(order, "inner")
						return nextInvoke()
					end,
				},
			})
			local _, _, value = t.await(r.dispatch(player, "echo", { value = 7 }))
			t.isTrue(value.ok)
			t.eq(value.output.value, 7)
			t.eq(table.concat(order, ","), "outer:echo,inner,run,outer:done")
		end)

		t.it("short-circuits when middleware rejects and reports via onError", function()
			local sawError, sawActionId
			local ran = false
			local r = createActionRegistry({
				guarded = {
					id = "guarded",
					run = function()
						ran = true
						return { ok = true }
					end,
				},
			}, {
				middleware = {
					function()
						error("not authorized")
					end,
				},
				onError = function(err, info)
					sawError = tostring(err)
					sawActionId = info.actionId
				end,
			})
			local _, _, value = t.await(r.dispatch(player, "guarded", nil))
			t.isFalse(value.ok)
			-- The client gets the masked error; onError gets the original.
			t.eq(value.errorName, "ActionInternalError")
			t.eq(value.error, "internal error")
			t.isFalse(ran, "handler never ran")
			t.contains(sawError, "not authorized")
			t.eq(sawActionId, "guarded")
		end)

		t.it("passes the player through the context", function()
			local r = createActionRegistry({
				whoami = {
					id = "whoami",
					run = function(_self, context, _input)
						return { userId = context.player.UserId }
					end,
				},
			})
			local _, _, value = t.await(r.dispatch(player, "whoami", nil))
			t.isTrue(value.ok)
			t.eq(value.output.userId, 1)
		end)

		t.it("awaits a Promise returned by run", function()
			local r = createActionRegistry({
				later = {
					id = "later",
					run = function()
						return Promise.resolve(42)
					end,
				},
			})
			local _, _, value = t.await(r.dispatch(player, "later", nil))
			t.isTrue(value.ok)
			t.eq(value.output, 42)
		end)

		t.it("rejects non-serializable input before user code", function()
			local ran = false
			local r = createActionRegistry({
				act = {
					id = "act",
					run = function()
						ran = true
						return true
					end,
				},
			})
			local _, _, value = t.await(r.dispatch(player, "act", { bad = function() end }))
			t.isFalse(value.ok)
			t.contains(value.error, "non-serializable action input")
			t.isFalse(ran, "user code did not run")
		end)

		t.it("rejects input that fails schema validation", function()
			local r = createActionRegistry({
				typed = {
					id = "typed",
					input = schema.object({ n = schema.number() }),
					run = function()
						return true
					end,
				},
			})
			local _, _, value = t.await(r.dispatch(player, "typed", { n = "not a number" }))
			t.isFalse(value.ok)
			t.contains(value.error, "Aruna action typed input validation failed")
			t.eq(value.errorName, "ActionValidationError")
			-- The failure carries the first failing path + reason.
			t.contains(value.error, "n: expected number")
		end)

		t.it("enforces the rate limit", function()
			local r = createActionRegistry({
				limited = {
					id = "limited",
					rateLimit = { key = "global", windowMs = 60_000, max = 1 },
					run = function()
						return true
					end,
				},
			})
			local _, _, first = t.await(r.dispatch(player, "limited", nil))
			t.isTrue(first.ok)
			local _, _, second = t.await(r.dispatch(player, "limited", nil))
			t.isFalse(second.ok)
			t.contains(second.error, "rate limited")
			-- Structured error metadata crosses the dispatch result.
			t.eq(second.errorName, "ActionRateLimitError")
			t.isTrue(second.retryAfterMs >= 0, "rate-limit result carries retryAfterMs")
		end)

		t.it("applies the default rate limit to actions that declare none", function()
			local r = createActionRegistry({
				plain = {
					id = "plain",
					run = function()
						return true
					end,
				},
			}, { defaultRateLimit = { key = "global", windowMs = 60_000, max = 1 } })
			local _, _, first = t.await(r.dispatch(player, "plain", nil))
			t.isTrue(first.ok)
			local _, _, second = t.await(r.dispatch(player, "plain", nil))
			t.isFalse(second.ok)
			t.contains(second.error, "rate limited")
		end)

		t.it("lets a per-action rate limit override the default", function()
			local r = createActionRegistry({
				loose = {
					id = "loose",
					rateLimit = { key = "global", windowMs = 60_000, max = 2 },
					run = function()
						return true
					end,
				},
			}, { defaultRateLimit = { key = "global", windowMs = 60_000, max = 1 } })
			local _, _, first = t.await(r.dispatch(player, "loose", nil))
			t.isTrue(first.ok)
			local _, _, second = t.await(r.dispatch(player, "loose", nil))
			t.isTrue(second.ok, "per-action max of 2 must win over default max of 1")
			local _, _, third = t.await(r.dispatch(player, "loose", nil))
			t.isFalse(third.ok)
		end)

		t.it("rejects non-serializable output", function()
			local r = createActionRegistry({
				leak = {
					id = "leak",
					run = function()
						return { handler = function() end }
					end,
				},
			})
			local _, _, value = t.await(r.dispatch(player, "leak", nil))
			t.isFalse(value.ok)
			t.contains(value.error, "non-serializable action output")
			t.eq(value.errorName, "ActionSerializationError")
		end)

		t.it("passes output that matches the output schema", function()
			local r = createActionRegistry({
				typed = {
					id = "typed",
					output = schema.object({ ok = schema.boolean() }),
					run = function()
						return { ok = true }
					end,
				},
			})
			local _, _, value = t.await(r.dispatch(player, "typed", nil))
			t.isTrue(value.ok)
			t.eq(value.output.ok, true)
		end)

		t.it("routes an output schema failure through middleware and onError", function()
			local seenByMiddleware, seenByOnError, sawActionId
			local r = createActionRegistry({
				typed = {
					id = "typed",
					output = schema.object({ ok = schema.boolean() }),
					run = function()
						return { ok = "yes" }
					end,
				},
			}, {
				middleware = {
					function(_info, nextInvoke)
						return nextInvoke():catch(function(reason)
							seenByMiddleware = reason
							error(reason)
						end)
					end,
				},
				onError = function(err, info)
					seenByOnError = err
					sawActionId = info.actionId
				end,
			})
			local _, _, value = t.await(r.dispatch(player, "typed", nil))
			t.isFalse(value.ok)
			t.eq(value.errorName, "ActionValidationError")
			t.contains(value.error, "Aruna action typed output validation failed")
			t.contains(value.error, "ok: expected boolean")
			t.eq(seenByMiddleware.name, "ActionValidationError", "middleware saw the failure")
			t.eq(seenByOnError.name, "ActionValidationError", "onError saw the failure")
			t.eq(sawActionId, "typed")
		end)

		t.it("accepts Roblox value-type output (Vector3) as wire-safe", function()
			local r = createActionRegistry({
				spawn = {
					id = "spawn",
					run = function()
						return roblox.Vector3.new(1, 2, 3)
					end,
				},
			})
			local _, _, value = t.await(r.dispatch(player, "spawn", nil))
			t.isTrue(value.ok, "Vector3 output must pass the serialization boundary")
			t.eq(typeof(value.output), "Vector3")
		end)

		t.it("captures synchronous errors thrown by run", function()
			local r = createActionRegistry({
				boom = {
					id = "boom",
					run = function()
						error("explosion")
					end,
				},
			})
			local settled, ok, value = t.await(r.dispatch(player, "boom", nil))
			t.isTrue(settled, "dispatch settled")
			t.isTrue(ok, "dispatch resolves rather than rejecting on a thrown handler")
			t.isFalse(value.ok)
			-- A Luau error names the script and line it came from, so the
			-- client only sees that something failed, and an id to report.
			t.eq(value.errorName, "ActionInternalError")
			t.eq(value.error, "internal error")
			t.isTrue(type(value.errorId) == "string", "masked error carries an errorId")
		end)

		t.it("sends the real message when exposeInternalErrors is set", function()
			local r = createActionRegistry({
				boom = {
					id = "boom",
					run = function()
						error("explosion")
					end,
				},
			}, { exposeInternalErrors = true })
			local _, _, value = t.await(r.dispatch(player, "boom", nil))
			t.isFalse(value.ok)
			t.contains(value.error, "explosion")
			t.eq(value.errorId, nil, "an exposed error is not masked, so carries no id")
		end)

		t.it("captures asynchronous rejections from run", function()
			local r = createActionRegistry({
				asyncBoom = {
					id = "asyncBoom",
					run = function()
						return Promise.reject("async explosion")
					end,
				},
			}, { exposeInternalErrors = true })
			local _, _, value = t.await(r.dispatch(player, "asyncBoom", nil))
			t.isFalse(value.ok)
			t.contains(value.error, "async explosion")
		end)
	end)
end
