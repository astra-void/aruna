--!nocheck
-- Execution coverage for the schema-driven binary codec (roblox/binary.ts).
local roblox = require("@lune/roblox")
local Vector3, Color3, CFrame = roblox.Vector3, roblox.Color3, roblox.CFrame
local Vector2, UDim, UDim2 = roblox.Vector2, roblox.UDim, roblox.UDim2
local BrickColor = roblox.BrickColor

return function(ctx)
	local t = ctx.t
	local schema = ctx.load("schema").schema
	local binary = ctx.load("binary")
	local encodeBinary, decodeBinary = binary.encodeBinary, binary.decodeBinary

	local function roundTrip(s, value)
		return decodeBinary(s, encodeBinary(s, value))
	end

	local schemaFingerprint = binary.schemaFingerprint

	t.describe("binary codec", function()
		t.it("round trips primitives", function()
			t.eq(roundTrip(schema.string(), "hello"), "hello")
			t.eq(roundTrip(schema.number(), 3.5), 3.5)
			t.eq(roundTrip(schema.number(), -42), -42)
			t.isTrue(roundTrip(schema.boolean(), true))
			t.isFalse(roundTrip(schema.boolean(), false))
		end)

		t.it("round trips utf-8 strings", function()
			t.eq(roundTrip(schema.string(), "안녕 🌙"), "안녕 🌙")
			t.eq(roundTrip(schema.string(), ""), "")
		end)

		t.it("spends no payload bytes on literals", function()
			local s = schema.literal("ready")
			local bytes = encodeBinary(s, "ready")
			t.eq(buffer.len(bytes), 4) -- frame header only
			t.eq(decodeBinary(s, bytes), "ready")
		end)

		t.it("round trips arrays", function()
			local s = schema.array(schema.number())
			local decoded = roundTrip(s, { 1, 2, 3 })
			t.eq(#decoded, 3)
			t.eq(decoded[1], 1)
			t.eq(decoded[3], 3)
			t.eq(#roundTrip(s, {}), 0)
		end)

		t.it("round trips objects", function()
			local s = schema.object({ amount = schema.number(), source = schema.string() })
			local decoded = roundTrip(s, { amount = 12, source = "trap" })
			t.eq(decoded.amount, 12)
			t.eq(decoded.source, "trap")
		end)

		t.it("round trips present and absent optionals", function()
			local s = schema.object({ name = schema.string(), nick = schema.optional(schema.string()) })
			local present = roundTrip(s, { name = "Ada", nick = "Bug" })
			t.eq(present.nick, "Bug")
			local absent = roundTrip(s, { name = "Ada" })
			t.eq(absent.nick, nil)
		end)

		t.it("round trips records with deterministic key order", function()
			local s = schema.record(schema.number())
			local decoded = roundTrip(s, { sword = 1, shield = 2, potion = 3 })
			t.eq(decoded.sword, 1)
			t.eq(decoded.shield, 2)
			t.eq(decoded.potion, 3)
			t.eq(next(roundTrip(s, {})), nil)
			-- Sorted-key encoding: bytes are stable regardless of authoring order.
			local a = encodeBinary(s, { sword = 1, shield = 2 })
			local b = encodeBinary(s, { shield = 2, sword = 1 })
			t.eq(buffer.tostring(a), buffer.tostring(b))
		end)

		t.it("round trips tuples without a length prefix", function()
			local s = schema.tuple({ schema.string(), schema.u8(), schema.boolean() })
			local decoded = roundTrip(s, { "sword", 3, true })
			t.eq(decoded[1], "sword")
			t.eq(decoded[2], 3)
			t.eq(decoded[3], true)
			-- 4-byte frame header + string("ab") = u32 len + 2 bytes = 6, u8 = 1, bool = 1.
			t.eq(buffer.len(encodeBinary(s, { "ab", 7, false })), 12)
		end)

		t.it("round trips enums and unions", function()
			local e = schema.enum({ "idle", "running", "done" })
			t.eq(roundTrip(e, "running"), "running")
			local u = schema.union({ schema.string(), schema.number() })
			t.eq(roundTrip(u, "text"), "text")
			t.eq(roundTrip(u, 99), 99)
		end)

		t.it("round trips each numeric width", function()
			t.eq(roundTrip(schema.u8(), 200), 200)
			t.eq(roundTrip(schema.u16(), 60000), 60000)
			t.eq(roundTrip(schema.u32(), 4000000000), 4000000000)
			t.eq(roundTrip(schema.i8(), -100), -100)
			t.eq(roundTrip(schema.i16(), -30000), -30000)
			t.eq(roundTrip(schema.i32(), -2000000000), -2000000000)
			t.eq(roundTrip(schema.f32(), 0.5), 0.5)
		end)

		t.it("packs each width to its declared byte count", function()
			t.eq(buffer.len(encodeBinary(schema.u8(), 1)), 4 + 1)
			t.eq(buffer.len(encodeBinary(schema.i8(), 1)), 4 + 1)
			t.eq(buffer.len(encodeBinary(schema.u16(), 1)), 4 + 2)
			t.eq(buffer.len(encodeBinary(schema.i16(), 1)), 4 + 2)
			t.eq(buffer.len(encodeBinary(schema.u32(), 1)), 4 + 4)
			t.eq(buffer.len(encodeBinary(schema.f32(), 1)), 4 + 4)
			t.eq(buffer.len(encodeBinary(schema.number(), 1)), 4 + 8)
		end)

		t.it("validates integer width ranges", function()
			t.isTrue(schema.u8().validate(255))
			t.isFalse(schema.u8().validate(256))
			t.isFalse(schema.u8().validate(-1))
			t.isFalse(schema.u8().validate(1.5))
			t.isTrue(schema.i16().validate(-32768))
			t.isFalse(schema.i16().validate(-32769))
		end)

		t.it("round trips a nested structure", function()
			local s = schema.object({
				id = schema.string(),
				tags = schema.array(schema.string()),
				stats = schema.object({ hp = schema.number(), alive = schema.boolean() }),
			})
			local decoded = roundTrip(s, {
				id = "p1",
				tags = { "a", "b" },
				stats = { hp = 100, alive = true },
			})
			t.eq(decoded.id, "p1")
			t.eq(#decoded.tags, 2)
			t.eq(decoded.tags[2], "b")
			t.eq(decoded.stats.hp, 100)
			t.isTrue(decoded.stats.alive)
		end)

		t.it("round trips Roblox userdata as native value types", function()
			-- f32-exact values so the round trip is bit-for-bit.
			local v = roundTrip(schema.vector3(), Vector3.new(1.5, -2.25, 0.5))
			t.eq(typeof(v), "Vector3")
			t.eq(v.X, 1.5)
			t.eq(v.Y, -2.25)
			t.eq(v.Z, 0.5)

			local c = roundTrip(schema.color3(), Color3.new(0.25, 0.5, 1))
			t.eq(typeof(c), "Color3")
			t.eq(c.R, 0.25)
			t.eq(c.B, 1)

			local cf = roundTrip(schema.cframe(), CFrame.new(1.5, 2, -0.5))
			t.eq(typeof(cf), "CFrame")
			local x, y, z = cf:GetComponents()
			t.eq(x, 1.5)
			t.eq(y, 2)
			t.eq(z, -0.5)
		end)

		t.it("packs each userdata kind to its declared byte count", function()
			t.eq(buffer.len(encodeBinary(schema.vector3(), Vector3.new(0, 0, 0))), 4 + 12)
			t.eq(buffer.len(encodeBinary(schema.color3(), Color3.new(0, 0, 0))), 4 + 12)
			t.eq(buffer.len(encodeBinary(schema.cframe(), CFrame.new(0, 0, 0))), 4 + 48)
		end)

		t.it("round trips 2D userdata as native value types", function()
			local v = roundTrip(schema.vector2(), Vector2.new(1.5, -2.25))
			t.eq(typeof(v), "Vector2")
			t.eq(v.X, 1.5)
			t.eq(v.Y, -2.25)

			local u = roundTrip(schema.udim(), UDim.new(0.5, -40))
			t.eq(typeof(u), "UDim")
			t.eq(u.Scale, 0.5)
			t.eq(u.Offset, -40)

			local u2 = roundTrip(schema.udim2(), UDim2.new(0.25, 12, 1, -8))
			t.eq(typeof(u2), "UDim2")
			t.eq(u2.X.Scale, 0.25)
			t.eq(u2.X.Offset, 12)
			t.eq(u2.Y.Scale, 1)
			t.eq(u2.Y.Offset, -8)
		end)

		t.it("packs each 2D userdata kind to its declared byte count", function()
			t.eq(buffer.len(encodeBinary(schema.vector2(), Vector2.new(0, 0))), 4 + 8)
			t.eq(buffer.len(encodeBinary(schema.udim(), UDim.new(0, 0))), 4 + 8)
			t.eq(buffer.len(encodeBinary(schema.udim2(), UDim2.new(0, 0, 0, 0))), 4 + 16)
		end)

		t.it("round trips BrickColor and refuses to encode an Instance", function()
			-- DateTime is not constructible under Lune; its codec is covered by the
			-- Node reference tests. BrickColor and Instance are.
			local bc = roundTrip(schema.brickColor(), BrickColor.new(194))
			t.eq(typeof(bc), "BrickColor")
			t.eq(bc.Number, 194)
			t.eq(buffer.len(encodeBinary(schema.brickColor(), BrickColor.new(1))), 4 + 2)

			local ok = pcall(function()
				encodeBinary(schema.instance(), roblox.Instance.new("Part"))
			end)
			t.isFalse(ok, "encoding an Instance schema throws")
		end)

		t.it("errors on a truncated buffer instead of raw buffer access", function()
			local full = encodeBinary(schema.string(), "hello")
			local truncated = buffer.create(6)
			buffer.copy(truncated, 0, full, 0, 6)
			local ok, err = pcall(function()
				decodeBinary(schema.string(), truncated)
			end)
			t.isFalse(ok, "truncated decode should throw")
			t.contains(tostring(err), "past the end")
		end)

		t.it("rejects a payload encoded with a different schema", function()
			local v1 = schema.object({ hp = schema.number() })
			local v2 = schema.object({ armor = schema.number(), hp = schema.number() })
			local bytes = encodeBinary(v1, { hp = 10 })
			local ok, err = pcall(function()
				decodeBinary(v2, bytes)
			end)
			t.isFalse(ok, "cross-schema decode should throw")
			t.contains(tostring(err), "schema mismatch")
		end)

		t.it("computes the same fingerprint as the Node reference runtime", function()
			-- Pinned expected value computed by the Node runtime for this exact
			-- schema (see the matching case in packages/aruna/test/binary.test.ts).
			-- If this changes on either side, the wire guard is broken.
			local s = schema.object({
				hp = schema.u16(),
				name = schema.string(),
				tags = schema.array(schema.string()),
				pos = schema.vector3(),
			})
			t.eq(schemaFingerprint(s), 2935581200)
		end)
	end)
end
