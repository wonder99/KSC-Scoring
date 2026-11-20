# Workspace Copilot Instructions

## Agent Delegation Rules

### @local-fast (qwen3-coder:latest)
Use for isolated, well-scoped subtasks:
- Writing boilerplate code
- Generating unit tests for a single file
- Formatting/regex/SQL snippets
- Simple docstrings
- Quick file lookups

### Copilot Fusion
Keep for complex tasks:
- Multi-file architecture design
- Cross-module refactoring
- Ambiguous debugging scenarios
- Final code review and quality assurance

## Task Routing

When any agent other than Local Fast is the main agent:
1. For a simple, self-contained task, actually invoke the Local Fast custom agent as a subagent using Copilot's native delegation mechanism. A text mention of `@local-fast` is not a delegation.
2. Keep complex analysis, multi-file changes, and final integration in Fusion Architect.
3. If the active agent is already Local Fast, handle the request directly rather than delegating recursively.
4. If the current harness cannot invoke a subagent, say so instead of claiming the task was delegated.

This division optimizes resource usage while maintaining quality.