--!nocheck
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
			t.eq(firstSchemaIssue(event, { type = "move", dx = "nope" }), "dx: expected number")
		end)
	end)
end
