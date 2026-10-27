--!nocheck
local roblox = require("@lune/roblox")

return function(ctx)
	local t = ctx.t
	local isWireSafe = ctx.load("serialization").isWireSafe
	local schema = ctx.load("schema").schema

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

		t.it("rejects NaN and infinities, top-level and nested", function()
			t.isFalse(isWireSafe(0 / 0))
			t.isFalse(isWireSafe(math.huge))
			t.isFalse(isWireSafe(-math.huge))
			t.isFalse(isWireSafe({ amount = 0 / 0 }))
			t.isFalse(isWireSafe({ 1, { 2, math.huge } }))
		end)

		t.it("accepts Roblox value types with finite components", function()
			t.isTrue(isWireSafe(roblox.Vector3.new(1, 2, 3)))
			t.isTrue(isWireSafe(roblox.Vector2.new(1, 2)))
			t.isTrue(isWireSafe(roblox.Color3.new(0, 0.5, 1)))
			t.isTrue(isWireSafe(roblox.CFrame.new(1, 2, 3)))
			t.isTrue(isWireSafe(roblox.UDim.new(0.5, 4)))
			t.isTrue(isWireSafe(roblox.UDim2.new(0.5, 4, 1, 0)))
		end)

		t.it("rejects Roblox value types with a non-finite component", function()
			local nan = 0 / 0
			t.isFalse(isWireSafe(roblox.Vector3.new(nan, 0, 0)))
			t.isFalse(isWireSafe(roblox.Vector3.new(0, 0, -math.huge)))
			t.isFalse(isWireSafe(roblox.Vector2.new(0, nan)))
			t.isFalse(isWireSafe(roblox.Color3.new(nan, 0, 0)))
			t.isFalse(isWireSafe(roblox.CFrame.new(0, math.huge, 0)))
			t.isFalse(isWireSafe(roblox.CFrame.new(0, 0, 0, nan, 0, 0, 0, 1, 0, 0, 0, 1)))
			t.isFalse(isWireSafe(roblox.UDim.new(nan, 0)))
			t.isFalse(isWireSafe(roblox.UDim2.new(0, 0, nan, 0)))
			-- Nested inside a plain table, too.
			t.isFalse(isWireSafe({ position = roblox.Vector3.new(nan, 0, 0) }))
		end)

		t.it("rejects a value with more than 2048 values in it, however shallow", function()
			local flat = {}
			for index = 1, 2047 do
				flat[index] = 0
			end
			t.isTrue(isWireSafe(flat), "2048 values including the table")
			flat[2048] = 0
			t.isFalse(isWireSafe(flat), "2049 values")
			t.isTrue(isWireSafe(flat, math.huge), "unbounded for a server-authored value")
		end)

		t.it("accepts an Instance only where the schema declares schema.instance()", function()
			local part = roblox.Instance.new("Part")
			t.isFalse(isWireSafe(part), "no schema")
			t.isFalse(isWireSafe({ part = part }), "no schema, nested")
			t.isTrue(isWireSafe(part, nil, schema.instance()))
			t.isTrue(isWireSafe(part, nil, schema.optional(schema.instance())))

			local shape = schema.object({ part = schema.instance(), name = schema.string() })
			t.isTrue(isWireSafe({ part = part, name = "a" }, nil, shape))
			t.isFalse(isWireSafe({ part = "a", name = part }, nil, shape), "in the wrong field")
			t.isFalse(isWireSafe({ part = part, extra = part }, nil, shape), "in an undeclared field")
			t.isTrue(isWireSafe({ part, part }, nil, schema.array(schema.instance())))
			t.isTrue(isWireSafe({ "a", part }, nil, schema.tuple({ schema.string(), schema.instance() })))
			t.isFalse(isWireSafe({ part, "a" }, nil, schema.tuple({ schema.string(), schema.instance() })))
			t.isTrue(isWireSafe(part, nil, schema.union({ schema.string(), schema.instance() })))
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
