--!nocheck
local roblox = require("@lune/roblox")

return function(ctx)
	local t = ctx.t
	local schema = ctx.load("schema").schema

	t.describe("schema", function()
		t.it("validates primitives", function()
			t.isTrue(schema.string().validate("x"))
			t.isFalse(schema.string().validate(5))
			t.isTrue(schema.number().validate(5))
			t.isFalse(schema.number().validate("5"))
			t.isTrue(schema.boolean().validate(true))
			t.isFalse(schema.boolean().validate(0))
		end)

		t.it("validates objects with required fields", function()
			local s = schema.object({ name = schema.string(), level = schema.number() })
			t.isTrue(s.validate({ name = "a", level = 3 }))
			t.isFalse(s.validate({ name = "a" }))
			t.isFalse(s.validate({ name = "a", level = "x" }))
			t.isFalse(s.validate("not a table"))
		end)

		t.it("validates arrays element-wise", function()
			local s = schema.array(schema.number())
			t.isTrue(s.validate({ 1, 2, 3 }))
			t.isTrue(s.validate({}))
			t.isFalse(s.validate({ 1, "x" }))
		end)

		t.it("validates records with string keys only", function()
			local s = schema.record(schema.number())
			t.isTrue(s.validate({ sword = 1, shield = 2 }))
			t.isTrue(s.validate({}))
			t.isFalse(s.validate({ sword = "one" }))
			t.isFalse(s.validate({ [1] = 5 }))
			t.isFalse(s.validate("not a table"))
		end)

		t.it("validates tuples positionally with exact length", function()
			local s = schema.tuple({ schema.string(), schema.number() })
			t.isTrue(s.validate({ "sword", 3 }))
			t.isFalse(s.validate({ "sword" }))
			t.isFalse(s.validate({ "sword", 3, true }))
			t.isFalse(s.validate({ "sword", "three" }))
			t.isFalse(s.validate(5))
		end)

		t.it("validates optional", function()
			local s = schema.optional(schema.number())
			t.isTrue(s.validate(nil))
			t.isTrue(s.validate(7))
			t.isFalse(s.validate("x"))
		end)

		t.it("validates literal", function()
			local s = schema.literal("on")
			t.isTrue(s.validate("on"))
			t.isFalse(s.validate("off"))
		end)

		t.it("validates enum", function()
			local s = schema.enum({ "red", "green", "blue" })
			t.isTrue(s.validate("green"))
			t.isFalse(s.validate("purple"))
		end)

		t.it("validates union", function()
			local s = schema.union({ schema.string(), schema.number() })
			t.isTrue(s.validate("x"))
			t.isTrue(s.validate(42))
			t.isFalse(s.validate(true))
		end)

		t.it("enforces number constraints via chaining", function()
			local level = schema.number().min(1).max(100).int()
			t.isTrue(level.validate(50))
			t.isFalse(level.validate(0))
			t.isFalse(level.validate(101))
			t.isFalse(level.validate(3.5))
		end)

		t.it("enforces string length constraints", function()
			local username = schema.string().minLength(3).maxLength(16)
			t.isTrue(username.validate("ada"))
			t.isFalse(username.validate("ab"))
			t.isFalse(username.validate("this-name-is-far-too-long"))
		end)

		t.it("enforces array length constraints", function()
			local hand = schema.array(schema.string()).minItems(1).maxItems(3)
			t.isTrue(hand.validate({ "a", "b" }))
			t.isFalse(hand.validate({}))
			t.isFalse(hand.validate({ "a", "b", "c", "d" }))
		end)

		t.it("runs a custom refine predicate after the structural check", function()
			local even = schema.number().refine(function(value)
				return value % 2 == 0
			end, "expected an even number")
			t.isTrue(even.validate(4))
			t.isFalse(even.validate(3))
			-- A non-number is rejected before the predicate ever runs.
			t.isFalse(even.validate("x"))
		end)

		t.it("reports the constraint message via firstSchemaIssue", function()
			local firstSchemaIssue = ctx.load("schema").firstSchemaIssue
			t.eq(firstSchemaIssue(schema.number().min(10), 5), "expected a number >= 10")
			t.eq(firstSchemaIssue(schema.string().minLength(3), "ab"), "expected length >= 3")
		end)

		t.it("keeps chained refinements immutable across branches", function()
			local base = schema.number().min(0)
			local capped = base.max(10)
			t.isTrue(base.validate(50))
			t.isFalse(capped.validate(50))
		end)

		t.it("dispatches a discriminated union on its discriminant", function()
			local event = schema.discriminatedUnion("type", {
				schema.object({ type = schema.literal("move"), dx = schema.number() }),
				schema.object({ type = schema.literal("chat"), text = schema.string() }),
			})
			t.isTrue(event.validate({ type = "move", dx = 5 }))
			t.isTrue(event.validate({ type = "chat", text = "hi" }))
			-- Selected member's own field must still validate.
			t.isFalse(event.validate({ type = "move", dx = "nope" }))
			-- Unknown discriminant fails.
			t.isFalse(event.validate({ type = "delete" }))
			t.isFalse(event.validate("not a table"))
		end)

		t.it("reports the discriminated member's field via firstSchemaIssue", function()
			local firstSchemaIssue = ctx.load("schema").firstSchemaIssue
			local event = schema.discriminatedUnion("type", {
				schema.object({ type = schema.literal("move"), dx = schema.number() }),
			})
			t.eq(firstSchemaIssue(event, { type = "move", dx = "nope" }), "dx: expected finite number")
		end)

		t.it("rejects NaN and infinities for every number format", function()
			local firstSchemaIssue = ctx.load("schema").firstSchemaIssue
			for _, build in { schema.number, schema.f32, schema.i32, schema.u32 } do
				local s = build()
				t.isTrue(s.validate(1))
				t.isFalse(s.validate(0 / 0), "NaN")
				t.isFalse(s.validate(math.huge), "inf")
				t.isFalse(s.validate(-math.huge), "-inf")
			end
			t.eq(firstSchemaIssue(schema.number(), 0 / 0), "expected finite number")
			t.eq(firstSchemaIssue(schema.f32(), math.huge), "expected finite number")
			t.eq(firstSchemaIssue(schema.object({ amount = schema.number() }), { amount = -math.huge }), "amount: expected finite number")
		end)

		t.it("rejects Roblox value types with a non-finite component", function()
			local firstSchemaIssue = ctx.load("schema").firstSchemaIssue
			local nan = 0 / 0
			local cases = {
				{ schema.vector3(), roblox.Vector3.new(1, 2, 3), roblox.Vector3.new(1, nan, 3), "expected Vector3 { x, y, z }" },
				{ schema.vector3(), roblox.Vector3.new(1, 2, 3), roblox.Vector3.new(math.huge, 2, 3), "expected Vector3 { x, y, z }" },
				{ schema.vector2(), roblox.Vector2.new(1, 2), roblox.Vector2.new(1, -math.huge), "expected Vector2 { x, y }" },
				{ schema.color3(), roblox.Color3.new(0, 0.5, 1), roblox.Color3.new(0, nan, 1), "expected Color3 { r, g, b }" },
				{ schema.cframe(), roblox.CFrame.new(1, 2, 3), roblox.CFrame.new(1, nan, 3), "expected CFrame { components: number[12] }" },
				-- A NaN in the rotation matrix, not the position.
				{ schema.cframe(), roblox.CFrame.new(1, 2, 3), roblox.CFrame.new(0, 0, 0, 1, 0, 0, 0, nan, 0, 0, 0, 1), "expected CFrame { components: number[12] }" },
				-- UDim offsets are int32 in the engine, so only the scale can be NaN.
				{ schema.udim(), roblox.UDim.new(0.5, 4), roblox.UDim.new(nan, 4), "expected UDim { scale, offset }" },
				{ schema.udim2(), roblox.UDim2.new(0.5, 4, 1, 0), roblox.UDim2.new(0.5, 4, math.huge, 0), "expected UDim2 { x: UDim, y: UDim }" },
			}
			for _, case in cases do
				local s, good, bad, message = case[1], case[2], case[3], case[4]
				t.isTrue(s.validate(good), `{message}: finite value`)
				t.isFalse(s.validate(bad), `{message}: non-finite value`)
				t.eq(firstSchemaIssue(s, bad), message)
			end
		end)

		t.it("validates BrickColor and Instance userdata", function()
			-- BrickColor and Instance are constructible under Lune; DateTime is not,
			-- so its validation is covered by the Node reference tests + typecheck.
			t.isTrue(schema.brickColor().validate(roblox.BrickColor.new(194)))
			t.isFalse(schema.brickColor().validate({ number = 194 }))
			t.isTrue(schema.instance().validate(roblox.Instance.new("Part")))
			t.isFalse(schema.instance().validate({}))
		end)

		t.it("fills defaults via applyDefaults and validates absent defaulted fields", function()
			local applyDefaults = ctx.load("schema").applyDefaults
			local s = schema.object({ count = schema.number().default(10), name = schema.string() })
			local filled = applyDefaults(s, { name = "a" })
			t.eq(filled.count, 10)
			t.eq(filled.name, "a")
			-- A provided value is kept.
			t.eq(applyDefaults(s, { name = "a", count = 3 }).count, 3)
			-- An absent defaulted field validates as ok (the default supplies it).
			t.isTrue(s.validate({ name = "a" }))
			t.isFalse(s.validate({ name = "a", count = "x" }))
		end)
	end)
end
