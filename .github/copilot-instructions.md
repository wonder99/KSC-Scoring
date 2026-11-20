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

When processing a request, evaluate if it's suitable for delegation:
1. If the task is simple and self-contained → delegate to @local-fast
2. If the task requires complex analysis or multi-file context → handle directly with Copilot Fusion
3. When in doubt, err on the side of using Copilot Fusion for thoroughness

This division optimizes resource usage while maintaining quality.