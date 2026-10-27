--!nocheck
-- Runs the shared dispatch conformance table against the compiled native
-- runtime. The Node runtime runs the same table under vitest; the table and its
-- format live in packages/aruna/test/conformance/.
--
-- The wire payload is the `registry.dispatch` result, which the native binder
-- fires as is, and nothing at all for a fireAndForget action.
local fs = require("@lune/fs")
local roblox = require("@lune/roblox")
local serde = require("@lune/serde")

return function(ctx)
	local t = ctx.t
	local schema = ctx.load("schema").schema
	local createActionRegistry = ctx.load("server-runtime").createActionRegistry
	local actionError = ctx.load("action-error").actionError

	local conformance = serde.decode("json", fs.readFile(ctx.conformancePath))

	local function toSchema(descriptor)
		local base
		if descriptor.type == "string" then
			base = schema.string()
			for _, constraint in { "minLength", "maxLength", "minChars", "maxChars" } do
				if descriptor[constraint] ~= nil then
					base = base[constraint](descriptor[constraint])
				end
			end
		elseif descriptor.type == "number" then
			base = if descriptor.format == "f32" then schema.f32() else schema.number()
		elseif descriptor.type == "boolean" then
			base = schema.boolean()
		elseif descriptor.type == "instance" then
			base = schema.instance()
		elseif descriptor.type == "object" then
			local fields = {}
			for key, field in descriptor.fields or {} do
				fields[key] = toSchema(field)
			end
			base = schema.object(fields)
		else
			error(`unknown schema descriptor type: {tostring(descriptor.type)}`)
		end
		if descriptor.default ~= nil then
			return base.default(descriptor.default)
		end
		return base
	end

	local nonFiniteNumbers = {
		NaN = 0 / 0,
		Infinity = math.huge,
		["-Infinity"] = -math.huge,
	}

	-- `{ "$function": true }` stands in for a function, and `{ "$number": "NaN" }`
	-- (or "Infinity" / "-Infinity") for a non-finite number: JSON can carry neither.
	-- `{ "$array": { "length": n, "of": value } }` builds a large array without
	-- writing it out.
	local function materialize(value)
		if type(value) ~= "table" then
			return value
		end
		if value["$function"] == true then
			return function() end
		end
		local className = value["$instance"]
		if type(className) == "string" then
			return roblox.Instance.new(className)
		end
		local repeated = value["$array"]
		if type(repeated) == "table" then
			local list = {}
			for index = 1, repeated.length do
				list[index] = materialize(repeated.of)
			end
			return list
		end
		local numberName = value["$number"]
		if type(numberName) == "string" then
			local nonFinite = nonFiniteNumbers[numberName]
			if nonFinite == nil then
				error(`unknown $number sentinel: {numberName}`)
			end
			return nonFinite
		end
		local copy = {}
		for key, entry in value do
			copy[key] = materialize(entry)
		end
		return copy
	end

	local function behaviorOf(fixture)
		local behavior = fixture.behavior
		if behavior == "echoInput" then
			return function(input)
				return input
			end
		elseif behavior == "returnConstant" then
			return function()
				return fixture.value
			end
		elseif behavior == "returnFunction" then
			return function()
				return { handler = function() end }
			end
		elseif behavior == "throwError" then
			return function()
				error(fixture.message)
			end
		elseif behavior == "throwTable" then
			return function()
				error({ name = fixture.errorName, message = fixture.message })
			end
		elseif behavior == "throwActionError" then
			return function()
				error(actionError(fixture.errorName, fixture.message))
			end
		end
		error(`unknown behavior: {tostring(behavior)}`)
	end

	local function deepEq(left, right)
		if type(left) ~= "table" or type(right) ~= "table" then
			return left == right
		end
		for key, value in left do
			if not deepEq(value, right[key]) then
				return false
			end
		end
		for key in right do
			if left[key] == nil then
				return false
			end
		end
		return true
	end

	local function show(value)
		if type(value) ~= "table" then
			return tostring(value)
		end
		local ok, encoded = pcall(serde.encode, "json", value)
		return if ok then encoded else tostring(value)
	end

	local player = { UserId = 1, Name = "Conformance" }

	t.describe("dispatch conformance (native)", function()
		for _, case in conformance.cases do
			t.it(case.name, function()
				local trace = {}
				local actions = {}
				for _, fixture in case.actions do
					local behave = behaviorOf(fixture)
					actions[fixture.id] = {
						id = fixture.id,
						input = if fixture.input ~= nil then toSchema(fixture.input) else nil,
						output = if fixture.output ~= nil then toSchema(fixture.output) else nil,
						rateLimit = fixture.rateLimit,
						fireAndForget = fixture.fireAndForget,
						run = function(_self, _context, input)
							table.insert(trace, "run")
							return behave(input)
						end,
					}
				end

				local middleware = {}
				for _, label in case.middleware or {} do
					table.insert(middleware, function(_info, nextInvoke)
						table.insert(trace, `{label}:before`)
						return nextInvoke():andThen(function(output)
							table.insert(trace, `{label}:after`)
							return output
						end)
					end)
				end

				local clockMs = 0
				local lastErrorId = nil
				local lastErrorName = nil
				local registry = createActionRegistry(actions, {
					middleware = middleware,
					onError = function(err, info)
						table.insert(trace, "onError")
						lastErrorId = info.errorId
						lastErrorName = if type(err) == "table" then err.name else nil
					end,
					exposeInternalErrors = case.exposeInternalErrors,
					nowMs = function()
						return clockMs
					end,
				})

				for _, step in case.steps do
					if step.advanceMs ~= nil then
						clockMs += step.advanceMs
						continue
					end

					lastErrorId = nil
					lastErrorName = nil
					local settled, ok, result =
						t.await(registry.dispatch(player, step.dispatch, materialize(step.input), step.idempotencyKey))
					t.isTrue(settled, "dispatch settled")
					t.isTrue(ok, "dispatch resolves rather than rejecting")
					local response = if registry.isFireAndForget(step.dispatch) then nil else result
					local expected = step.expect

					if expected.noResponse == true then
						t.eq(response, nil, "no response")
						continue
					end
					if response == nil then
						t.fail(`{step.dispatch}: expected a response, got none`)
					end
					if expected.ok ~= nil then
						t.eq(response.ok, expected.ok, `{step.dispatch} ok`)
					end
					if response.ok then
						if expected.output ~= nil and not deepEq(response.output, expected.output) then
							t.fail(`{step.dispatch} output: expected {show(expected.output)}, got {show(response.output)}`)
						end
					else
						if expected.errorName ~= nil then
							t.eq(response.errorName, expected.errorName, `{step.dispatch} errorName`)
						end
						if expected.message ~= nil then
							t.eq(response.error, expected.message, `{step.dispatch} message`)
						end
						if expected.messageContains ~= nil then
							t.contains(response.error, expected.messageContains, `{step.dispatch} message`)
						end
						if expected.errorId == true then
							t.isTrue(
								type(response.errorId) == "string" and string.match(response.errorId, "^%x%x%x%x%x%x%x%x$") ~= nil,
								`{step.dispatch} errorId is 8 hex digits: {tostring(response.errorId)}`
							)
							t.eq(response.errorId, lastErrorId, `{step.dispatch} errorId matches onError`)
						elseif expected.errorId == false then
							t.eq(response.errorId, nil, `{step.dispatch} carries no errorId`)
						end
						if expected.onErrorName ~= nil then
							t.eq(lastErrorName, expected.onErrorName, `{step.dispatch} onError error name`)
						end
					end
				end

				if not deepEq(trace, case.trace) then
					t.fail(`trace: expected {show(case.trace)}, got {show(trace)}`)
				end
			end)
		end
	end)
end
