--!nocheck
-- Tiny test framework: describe/it plus assertions and a Promise await helper
-- that pumps the Lune task scheduler.

local task = require("@lune/task")

local state = {
	passed = 0,
	failed = 0,
	failures = {},
	suite = "",
}

local function describe(name, fn)
	state.suite = name
	print(`\n{name}`)
	fn()
end

local function it(name, fn)
	local ok, err = pcall(fn)
	if ok then
		state.passed += 1
		print(`  ✓ {name}`)
	else
		state.failed += 1
		table.insert(state.failures, `{state.suite} › {name}\n      {tostring(err)}`)
		print(`  ✗ {name}`)
		print(`      {tostring(err)}`)
	end
end

local function fail(message)
	error(message, 2)
end

local function eq(actual, expected, message)
	if actual ~= expected then
		error(
			`{message or "values differ"}: expected {tostring(expected)}, got {tostring(actual)}`,
			2
		)
	end
end

local function isTrue(value, message)
	if value ~= true then
		error(`{message or "expected true"}: got {tostring(value)}`, 2)
	end
end

local function isFalse(value, message)
	if value ~= false then
		error(`{message or "expected false"}: got {tostring(value)}`, 2)
	end
end

local function contains(haystack, needle, message)
	if type(haystack) ~= "string" or string.find(haystack, needle, 1, true) == nil then
		error(`{message or "substring not found"}: {tostring(needle)} in {tostring(haystack)}`, 2)
	end
end

-- Resolves a Promise synchronously by pumping the scheduler until it settles or
-- the deadline passes. Returns (settled, ok, value).
local function await(promise, timeoutSeconds)
	local settled, ok, value = false, false, nil
	promise:andThen(function(result)
		settled, ok, value = true, true, result
	end, function(reason)
		settled, ok, value = true, false, reason
	end)

	local deadline = os.clock() + (timeoutSeconds or 1)
	while not settled and os.clock() < deadline do
		task.wait()
	end
	return settled, ok, value
end

local function finish()
	print(`\n{state.passed} passed, {state.failed} failed`)
	if state.failed > 0 then
		print("\nFailures:")
		for _, failure in state.failures do
			print(`  - {failure}`)
		end
	end
	return state.failed
end

return {
	describe = describe,
	it = it,
	fail = fail,
	eq = eq,
	isTrue = isTrue,
	isFalse = isFalse,
	contains = contains,
	await = await,
	finish = finish,
}
