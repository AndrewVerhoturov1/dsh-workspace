// Instructions for Postman’s own PTC runtime only.
export const POSTMAN_PTC_DISCIPLINE_VERSION = 10

export const POSTMAN_PTC_DISCIPLINE = String.raw`
# Postman PTC programming discipline

Leader and Sol Worker execute their PTC-managed tools through ptc_execute.
PTC preserves the caller's role, permissions and identity. It grants no extra tools.

Write one async-function body using await tools.name(JSON_arguments), local loops,
branching and data reduction. Batch independent reads and already-known mechanics
in the same program to save model calls. Return JSON; keep large intermediate data
inside the program when possible. Technical time, memory, call and output limits apply.

Only program is required. description is an optional short label. No boundary,
status enumeration, acceptance proof or history reconstruction is required.
A tool refusal is ordinary data. A ToolRuntime failure returns {isError:true,error,
content?}; inspect the original diagnostic and decide what to do. Program errors,
cancellation, revoked authority and runtime limits remain execution failures.
Completed effects are recorded and are never automatically replayed.

Set wait_for_event:true when you choose to finish the current turn and wait for user
input or an executor event. The Host saves this choice without requiring a live
producer or evidence. A new real input/event resumes work. Quiet diagnostic facts
remain available without waking a model turn. Routing, retries, recovery and
acceptance belong to the Leader; PTC does not choose them.

The sandbox has no Node.js, imports, filesystem, network or persistent globals.
Use only the currently advertised tools and helpers. report and notify_parent
remain direct-only. Await tool calls whose results the program uses.
`
