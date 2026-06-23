--!nocheck
return function(ctx)
	local t = ctx.t
	local isWireSafe = ctx.load("serialization").isWireSafe

	t.describe("serialization (plain-data-v1)", function()
		t.it("accepts wire-safe primitives", function()
			t.isTrue(isWireSafe("x"))
			t.isTrue(isWireSafe(5))
			t.isTrue(isWireSafe(true))
			t.isTrue(isWireSafe(nil))
		end)

		t.it("accepts nested plain tables and arrays", function()
			t.isTrue(isWireSafe({ a = 1, b = { c = "x", d = { 1, 2, 3 } } }))
			t.isTrue(isWireSafe({ 1, 2, { 3, 4 } }))
		end)

		t.it("rejects functions and threads", function()
			t.isFalse(isWireSafe(function() end))
			t.isFalse(isWireSafe(coroutine.create(function() end)))
			t.isFalse(isWireSafe({ ok = true, bad = function() end }))
		end)

		t.it("rejects cyclic tables", function()
			local cyclic = {}
			cyclic.self = cyclic
			t.isFalse(isWireSafe(cyclic))
		end)

		t.it("rejects tables nested past the depth limit", function()
			local deep = {}
			local cursor = deep
			for _ = 1, 40 do
				cursor.next = {}
				cursor = cursor.next
			end
			t.isFalse(isWireSafe(deep))
		end)
	end)
end
