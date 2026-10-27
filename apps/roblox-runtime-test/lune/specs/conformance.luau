--!nocheck
-- Runs the shared dispatch conformance table against the compiled native
-- runtime. The Node runtime runs the same table under vitest; the table and its
-- format live in packages/aruna/test/conformance/.
--
-- The wire payload is the `registry.dispatch` result, which the native binder
-- fires as is, and nothing at all for a fireAndForget action.
local fs = require("@lune/fs")
local serde = require("@lune/serde")

return function(ctx)
	local t = ctx.t
	local schema = ctx.load("schema").schema
	local createActionRegistry = ctx.load("server-runtime").createActionRegistry

	local conformance = serde.decode("json", fs.readFile(ctx.conformancePath))

	local function toSchema(descriptor)
		local base
		if descriptor.type == "string" then
			base = schema.string()
		elseif descriptor.type == "number" then
			base = schema.number()
		elseif descriptor.type == "boolean" then
			base = schema.boolean()
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

	-- `{ "$function": true }` stands in for a function, which JSON cannot carry.
	local function materialize(value)
		if type(value) ~= "table" then
			return value
		end
		if value["$function"] == true then
			return function() end
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
				local registry = createActionRegistry(actions, {
					middleware = middleware,
					onError = function()
						table.insert(trace, "onError")
					end,
					nowMs = function()
						return clockMs
					end,
				})

				for _, step in case.steps do
					if step.advanceMs ~= nil then
						clockMs += step.advanceMs
						continue
					end

					local settled, ok, result =
						t.await(registry.dispatch(player, step.dispatch, materialize(step.input)))
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
						if expected.messageContains ~= nil then
							t.contains(response.error, expected.messageContains, `{step.dispatch} message`)
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
