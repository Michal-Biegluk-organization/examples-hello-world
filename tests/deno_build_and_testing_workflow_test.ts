function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertMatch(actual: string, expected: RegExp): void {
  assert(
    expected.test(actual),
    `Expected ${JSON.stringify(actual)} to match ${expected}`,
  );
}

function assertStringIncludes(actual: string, expected: string): void {
  assert(
    actual.includes(expected),
    `Expected text to include ${JSON.stringify(expected)}`,
  );
}

const repositoryRoot = new URL("../", import.meta.url);
const workflowName = "deno-build-and-testing.yml";
const canonicalWorkflow = new URL(
  `.github/workflows/${workflowName}`,
  repositoryRoot,
);
const caseVariantWorkflow = new URL(
  ".GitHub/workflows/Deno-build-and-testing.yml",
  repositoryRoot,
);

async function exists(url: URL): Promise<boolean> {
  try {
    await Deno.stat(url);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false;
    }
    throw error;
  }
}

async function readWorkflow(): Promise<string> {
  if (await exists(canonicalWorkflow)) {
    return await Deno.readTextFile(canonicalWorkflow);
  }

  // Read the current case-variant path so the remaining contract tests still
  // provide useful results when the discovery-path regression is present.
  return await Deno.readTextFile(caseVariantWorkflow);
}

Deno.test("workflow uses GitHub's discoverable directory casing", async () => {
  assert(
    await exists(canonicalWorkflow),
    `GitHub only discovers workflows under .github/workflows; move ${workflowName} to that directory`,
  );
});

Deno.test("workflow runs for pushes and pull requests targeting main", async () => {
  const workflow = await readWorkflow();

  assertStringIncludes(
    workflow,
    "on:\n  push:\n    branches:\n      - main\n  pull_request:\n    branches:\n      - main",
  );
  assert(
    !workflow.includes("pull_request_target:"),
    "pull_request_target would execute untrusted pull-request code with elevated context",
  );
});

Deno.test("workflow has bounded, least-privilege job settings", async () => {
  const workflow = await readWorkflow();

  assertStringIncludes(workflow, "permissions:\n  contents: read");
  assertStringIncludes(
    workflow,
    "  deno:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5",
  );
  assert(
    !/^\s+[\w-]+: write$/m.test(workflow),
    "CI validation must not receive write permissions",
  );
});

Deno.test("workflow installs the intended Deno major before validation", async () => {
  const workflow = await readWorkflow();
  const checkoutIndex = workflow.indexOf("uses: actions/checkout@v4");
  const setupIndex = workflow.indexOf("uses: denoland/setup-deno@v2");
  const validationIndex = workflow.indexOf("run: deno fmt --check");

  assert(checkoutIndex >= 0, "checkout action must be pinned to v4");
  assert(setupIndex > checkoutIndex, "Deno setup must follow checkout");
  assertStringIncludes(workflow, "deno-version: v2.x");
  assert(
    validationIndex > setupIndex,
    "validation commands must run after Deno is installed",
  );
});

Deno.test("workflow runs every declared validation in fail-fast order", async () => {
  const workflow = await readWorkflow();
  const validationSteps = [
    ["Verify formatting", "deno fmt --check"],
    ["Run linter", "deno lint"],
    ["Run tests", "deno task test"],
    ["Run type check", "deno check *.ts"],
  ] as const;

  let previousIndex = -1;
  for (const [name, command] of validationSteps) {
    const stepIndex = workflow.indexOf(`- name: ${name}`);
    assert(
      stepIndex > previousIndex,
      `${name} must be present and correctly ordered`,
    );
    assert(
      workflow.indexOf(command, stepIndex) > stepIndex,
      `${name} must execute ${command}`,
    );
    previousIndex = stepIndex;
  }

  assertStringIncludes(workflow, "deno check **/*.ts");
  assertStringIncludes(workflow, "deno check **/**/*.ts");
  assert(
    !workflow.includes("continue-on-error:"),
    "validation failures must fail the workflow",
  );
});

Deno.test("workflow test command resolves to a declared Deno task", async () => {
  const configText = await Deno.readTextFile(
    new URL("deno.json", repositoryRoot),
  );
  const config = JSON.parse(configText) as {
    tasks?: Record<string, string>;
  };
  const testTask = config.tasks?.test;

  assert(
    typeof testTask === "string",
    "deno.json must declare the test task invoked by the workflow",
  );
  assertMatch(testTask, /(?:^|\s)deno\s+test(?:\s|$)/);
});

Deno.test("workflow validation cannot enter watch or debug mode", async () => {
  const workflow = await readWorkflow();

  assert(
    !/\s--(?:watch|inspect|inspect-brk)(?:=|\s|$)/.test(workflow),
    "CI validation commands must terminate without waiting for input",
  );
});
