import { strict as assert } from "assert";
import { attachTaskUrl } from "./task-creation-bridge.js";

const result = attachTaskUrl(
  { request_id: "REQ_20260901T120000Z_1234" },
  "https://github.com/task.md"
);

assert.equal(result.state, "TASK_CREATED");
assert.equal(result.task_url, "https://github.com/task.md");
