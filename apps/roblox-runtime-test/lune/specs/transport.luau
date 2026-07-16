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
end
