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
			t.isTrue(limiter.check("buy", "player:1", options))
			t.isTrue(limiter.check("buy", "player:1", options))
			t.isFalse(limiter.check("buy", "player:1", options))
		end)

		t.it("tracks keys independently", function()
			local limiter = createActionRateLimiter()
			local options = { key = "player", windowMs = 60_000, max = 1 }
			t.isTrue(limiter.check("buy", "player:1", options))
			t.isFalse(limiter.check("buy", "player:1", options))
			t.isTrue(limiter.check("buy", "player:2", options))
		end)

		t.it("resets after the window elapses", function()
			local limiter = createActionRateLimiter()
			local options = { key = "global", windowMs = 50, max = 1 }
			t.isTrue(limiter.check("ping", "global", options))
			t.isFalse(limiter.check("ping", "global", options))
			task.wait(0.08)
			t.isTrue(limiter.check("ping", "global", options))
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
			t.eq(resolveRateLimitKey({ key = "global" }, { UserId = 9 }), "global")
			t.eq(resolveRateLimitKey({ key = "player" }, { UserId = 9 }), "player:9")
		end)
	end)
end
