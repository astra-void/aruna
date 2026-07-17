--!nocheck
return function(ctx)
	local t = ctx.t
	local transport = ctx.load("roblox")
	local createActionRegistry = ctx.load("server-runtime").createActionRegistry

	t.describe("RemoteEvent transport", function()
		local fired = { count = 0 }
		local registry = createActionRegistry({
			ping = {
				id = "ping",
				run = function(_self, _context, input)
					return { reply = input.msg }
				end,
			},
			-- One-way action: the server runs it but sends no response.
			fire = {
				id = "fire",
				fireAndForget = true,
				run = function(_self, _context, input)
					fired.count += 1
					fired.last = input
					return { ignored = true }
				end,
			},
		})
		-- Bind the server first so the shared remote exists, then build a client
		-- invoker that waits for it.
		local binding = transport.bindActions(registry)
		local invoke = transport.createActionInvoker()

		t.it("completes a client -> server -> client round trip", function()
			local settled, ok, value = t.await(invoke("ping", { msg = "hello" }))
			t.isTrue(settled, "round trip settled")
			t.isTrue(ok, "invoker resolved")
			t.eq(value.reply, "hello")
		end)

		t.it("rejects when the server reports a failure", function()
			local settled, ok, value = t.await(invoke("missing", {}))
			t.isTrue(settled, "round trip settled")
			t.isFalse(ok, "invoker rejected")
			-- Rejections are structured: message + optional name/retryAfterMs.
			t.contains(value.message, "unknown action")
		end)

		t.it("fire-and-forget resolves immediately with no value", function()
			-- The client does not wait for an ack: the invoke promise resolves to
			-- nil right away rather than threading a server response.
			local settled, ok, value = t.await(invoke("fire", { n = 5 }, { fireAndForget = true }))
			t.isTrue(settled, "fire-and-forget settled")
			t.isTrue(ok, "fire-and-forget resolved")
			t.eq(value, nil, "fire-and-forget resolves with no value")
			-- The registry exposes the one-way flag the binder uses to skip the
			-- response.
			t.isTrue(registry.isFireAndForget("fire"), "fire is fire-and-forget")
			t.isFalse(registry.isFireAndForget("ping"), "ping is two-way")
		end)

		t.it("rejects with a timeout when no response arrives", function()
			-- Drop the server listener so requests get no reply.
			binding.disconnect()
			local timedInvoke = transport.createActionInvoker({ requestTimeoutMs = 20 })
			local settled, ok, value = t.await(timedInvoke("ping", { msg = "x" }), 0.5)
			t.isTrue(settled, "timeout settled")
			t.isFalse(ok, "invoker rejected")
			t.contains(value.message, "timed out")
			t.eq(value.name, "ActionTimeoutError")
		end)
	end)

	t.describe("client middleware", function()
		local clientRuntime = ctx.load("client-runtime")
		local withClientMiddleware = clientRuntime.withClientMiddleware

		t.it("wraps the invoker outermost-first and observes the result", function()
			local calls = {}
			local base = function(actionId, _input, _options)
				table.insert(calls, "invoke:" .. actionId)
				return ctx.Promise.resolve({ ok = true })
			end
			local outer = function(info, nextInvoke)
				table.insert(calls, "outer:before:" .. info.actionId)
				return nextInvoke():andThen(function(result)
					table.insert(calls, "outer:after")
					return result
				end)
			end
			local inner = function(_info, nextInvoke)
				table.insert(calls, "inner:before")
				return nextInvoke()
			end

			local wrapped = withClientMiddleware(base, { outer, inner })
			local settled, ok = t.await(wrapped("shop.buy", { n = 1 }))
			t.isTrue(settled, "settled")
			t.isTrue(ok, "resolved")
			t.eq(calls[1], "outer:before:shop.buy")
			t.eq(calls[2], "inner:before")
			t.eq(calls[3], "invoke:shop.buy")
			t.eq(calls[4], "outer:after")
		end)

		t.it("a layer that rejects short-circuits the invoker", function()
			local invoked = { hit = false }
			local base = function(_actionId, _input, _options)
				invoked.hit = true
				return ctx.Promise.resolve("unreachable")
			end
			local block = function(_info, _nextInvoke)
				return ctx.Promise.reject({ message = "blocked", name = "BlockedError" })
			end

			local wrapped = withClientMiddleware(base, { block })
			local settled, ok, value = t.await(wrapped("shop.buy", {}))
			t.isTrue(settled, "settled")
			t.isFalse(ok, "rejected")
			t.eq(value.name, "BlockedError")
			t.isFalse(invoked.hit, "invoker never ran")
		end)
	end)

	t.describe("client contract handshake", function()
		local registry = createActionRegistry({
			ping = {
				id = "ping",
				run = function(_self, _context, input)
					return { reply = input.msg }
				end,
			},
		})

		t.it("fires onVersionMismatch but still invokes when warn-only", function()
			local binding = transport.bindActions(registry, "server-hash")
			local mismatches = {}
			local invoke = transport.createActionInvoker({
				expectedContractHash = "client-hash",
				onVersionMismatch = function(info)
					table.insert(mismatches, info)
				end,
			})

			t.eq(#mismatches, 1)
			t.eq(mismatches[1].expected, "client-hash")
			t.eq(mismatches[1].actual, "server-hash")

			local settled, ok, value = t.await(invoke("ping", { msg = "hi" }))
			t.isTrue(settled, "settled")
			t.isTrue(ok, "warn-only still resolves")
			t.eq(value.reply, "hi")
			binding.disconnect()
		end)

		t.it("rejects invokes when rejectOnMismatch is set", function()
			local binding = transport.bindActions(registry, "server-hash")
			local invoke = transport.createActionInvoker({
				expectedContractHash = "client-hash",
				rejectOnMismatch = true,
			})

			local settled, ok, value = t.await(invoke("ping", { msg = "x" }))
			t.isTrue(settled, "settled")
			t.isFalse(ok, "rejected")
			t.eq(value.name, "ActionVersionMismatchError")
			binding.disconnect()
		end)

		t.it("does nothing when the client and server hashes match", function()
			local binding = transport.bindActions(registry, "same-hash")
			local mismatches = {}
			local invoke = transport.createActionInvoker({
				expectedContractHash = "same-hash",
				onVersionMismatch = function(info)
					table.insert(mismatches, info)
				end,
			})

			t.eq(#mismatches, 0)
			local settled, ok = t.await(invoke("ping", { msg = "ok" }))
			t.isTrue(settled, "settled")
			t.isTrue(ok, "resolved")
			binding.disconnect()
		end)
	end)

	t.describe("client retry", function()
		local clientRuntime = ctx.load("client-runtime")
		local withRetry = clientRuntime.withRetry
		-- An immediate delay so the backoff schedule never actually waits.
		local immediateDelay = function(_delayMs)
			return ctx.Promise.resolve()
		end

		t.it("retries a rate-limit rejection and eventually succeeds", function()
			local attempts = { count = 0 }
			local base = function(_actionId, _input, _options)
				attempts.count += 1
				if attempts.count < 3 then
					return ctx.Promise.reject({
						message = "rate limited",
						name = "ActionRateLimitError",
						retryAfterMs = 10,
					})
				end
				return ctx.Promise.resolve({ ok = true })
			end

			local wrapped = withRetry(base, { maxRetries = 3 }, immediateDelay)
			local settled, ok, value = t.await(wrapped("shop.buy", {}))
			t.isTrue(settled, "settled")
			t.isTrue(ok, "resolved after retries")
			t.isTrue(value.ok, "final value ok")
			t.eq(attempts.count, 3)
		end)

		t.it("does not retry a non-retryable rejection", function()
			local attempts = { count = 0 }
			local base = function(_actionId, _input, _options)
				attempts.count += 1
				return ctx.Promise.reject({ message = "bad", name = "ActionValidationError" })
			end

			local wrapped = withRetry(base, { maxRetries = 3 }, immediateDelay)
			local settled, ok, value = t.await(wrapped("shop.buy", {}))
			t.isTrue(settled, "settled")
			t.isFalse(ok, "rejected")
			t.eq(value.name, "ActionValidationError")
			t.eq(attempts.count, 1)
		end)
	end)

	t.describe("RemoteEvent transport cancellation", function()
		local createCancelToken = ctx.load("client-runtime").createCancelToken
		local ran = { count = 0 }
		local registry = createActionRegistry({
			slow = {
				id = "slow",
				run = function(_self, _context, _input)
					ran.count += 1
					return { ok = true }
				end,
			},
		})
		local binding = transport.bindActions(registry)

		t.it("an already-cancelled signal rejects before firing the server", function()
			local invoke = transport.createActionInvoker()
			local cancel = createCancelToken()
			cancel.cancel()
			local before = ran.count
			local settled, ok, value = t.await(invoke("slow", { n = 1 }, { signal = cancel }))
			t.isTrue(settled, "cancellation settled")
			t.isFalse(ok, "invoker rejected")
			t.eq(value.name, "ActionCancelledError")
			t.eq(ran.count, before, "server action never ran")
		end)

		t.it("cancelling a pending request rejects it with ActionCancelledError", function()
			-- Drop the server so no response ever arrives: the request stays
			-- pending until we cancel it (timeout disabled so only cancel settles).
			binding.disconnect()
			local pendingInvoke = transport.createActionInvoker({ requestTimeoutMs = 0 })
			local cancel = createCancelToken()
			local promise = pendingInvoke("slow", { n = 2 }, { signal = cancel })
			cancel.cancel()
			local settled, ok, value = t.await(promise, 0.5)
			t.isTrue(settled, "cancellation settled")
			t.isFalse(ok, "invoker rejected")
			t.eq(value.name, "ActionCancelledError")
		end)
	end)
end
