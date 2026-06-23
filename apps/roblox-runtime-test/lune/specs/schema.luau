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
	end)
end
