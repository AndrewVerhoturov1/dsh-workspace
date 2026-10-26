---
name: postman-leader-nodes
description: Opt-in Postman Leader PTC with NodesAgent native TeamRun and editable visual team policy.
---

# Postman Leader PTC — Nodes (copy)

This preset is a top-level Postman supervisor only. All Postman PTC, Bridge, Secretary, Sol, and Worker restrictions remain native and binding-based. Never infer capabilities from a node's display name. The normal postman-leader skill governs your management processes; this skill adds rules only for this opt-in preset.

1. Open NodesAgent_by_Andrew in the Conversation view. In a fresh DSH Chat, choose **Use Agent Team** to bind one saved TeamDefinition to that Chat's native Entry Agent.
2. The saved TeamRun is the sole source of node-to-DSH-session identity, native role mapping, allowed communication, and formal task authority. Do not create a second orchestration owner and do not use generic one-shot subagent engines for this team.
3. The preset supports one Entry, one Secretary, two direct Workers, one Sol, and two Sol-owned Workers. These are native quota ceilings, not configurable permissions. Devspace communication lanes are separately owned and are not ordinary model-configurable AgentNodes.
4. A native postman_worker/postman_secretary/postman_sol_worker tool can only create or address a worker permitted by the current TeamRun. The **nodes_team_message**, **nodes_team_assign_task**, and **nodes_team_complete_task** tools are the controlled, durable cross-node operations. Ordinary messages are not Tasks. The manager chooses subsequent work.
5. A worker Session can never inherit leader or Sol rights by changing its graph role. Tool grants restrict actual execution, and skill grants restrict the scoped DSH catalog/loader on creation and cold resume. Skill controls do not hide filesystem contents or erase prior history; canonical Postman role instructions remain fixed.
6. Only one new TeamRun per fresh root DSH Session. Pause prevents new team delivery; Resume continues the same sessions; Stop forbids new team work. Existing in-flight turns are not forcibly cancelled.
7. Use the standard native Postman tools and PTC, not direct PTC-managed calls. Follow applicable repository policy and do not use this skill to expand the current user's task.
