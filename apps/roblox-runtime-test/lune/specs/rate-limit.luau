--!nocheck
local task = require("@lune/task")

return function(ctx)
	local t = ctx.t
	local mod = ctx.load("rate-limit")
	local createActionRateLimiter = mod.createActionRateLimiter
	local resolveRateLimitKey = mod.resolveRateLimitKey

	t.describe("rate-limit (fixed window)", function()
		t.it("allows up to max within a window then rejects", function()
			local limiter = createActionRateLimiter()
			local options = { key = "player", windowMs = 60_000, max = 2 }
			t.isTrue(limiter.check("buy", "player:1", options).ok)
			t.isTrue(limiter.check("buy", "player:1", options).ok)
			local rejected = limiter.check("buy", "player:1", options)
			t.isFalse(rejected.ok)
			t.isTrue(rejected.retryAfterMs >= 0, "rejection carries retryAfterMs")
			t.isTrue(rejected.resetAtMs > 0, "rejection carries resetAtMs")
		end)

		t.it("tracks keys independently", function()
			local limiter = createActionRateLimiter()
			local options = { key = "player", windowMs = 60_000, max = 1 }
			t.isTrue(limiter.check("buy", "player:1", options).ok)
			t.isFalse(limiter.check("buy", "player:1", options).ok)
			t.isTrue(limiter.check("buy", "player:2", options).ok)
		end)

		t.it("resets after the window elapses", function()
			local limiter = createActionRateLimiter()
			local options = { key = "global", windowMs = 50, max = 1 }
			t.isTrue(limiter.check("ping", "global", options).ok)
			t.isFalse(limiter.check("ping", "global", options).ok)
			task.wait(0.08)
			t.isTrue(limiter.check("ping", "global", options).ok)
		end)

		t.it("purge removes expired buckets", function()
			local limiter = createActionRateLimiter()
			local options = { key = "global", windowMs = 50, max = 5 }
			limiter.check("ping", "global", options)
			t.eq(limiter.purge(os.clock()), 0, "fresh bucket is not expired")
			task.wait(0.08)
			t.eq(limiter.purge(os.clock()), 1, "elapsed bucket is purged")
		end)

		t.it("resolves rate-limit keys", function()
			local info = { actionId = "buy", player = { UserId = 9 } }
			t.eq(resolveRateLimitKey({ key = "global" }, info), "global")
			t.eq(resolveRateLimitKey({ key = "player" }, info), "player:9")
		end)

		t.it("resolves a per-action custom key function", function()
			local options = {
				key = function(callInfo)
					return "target:" .. callInfo.input.targetId
				end,
			}
			local resolved = resolveRateLimitKey(options, {
				actionId = "trade.offer",
				player = { UserId = 9 },
				input = { targetId = "x" },
			})
			t.eq(resolved, "target:x")
		end)
	end)
end
