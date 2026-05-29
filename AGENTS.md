# AGENTS.md

## Purpose

This file defines the working rules for any AI coding, design, or architecture agent working in this project.

Before writing any code, UI, database logic, refactor, or system design, the agent MUST first read the AI Skill knowledge base from Obsidian.

---

## Obsidian AI Skill Path

Primary Knowledge Base Location:

```text
C:\Users\OUTLET007\Documents\Obsidian Vault\AI SKILL
```

The agent MUST read this knowledge base before starting any task.

---

## Mandatory Reading Order

Before starting any task, read the following in order:

1. `README.md`
2. `00-Overview/`
3. `01-Core-Skill/`
4. `04-AI-Rules/`
5. `05-Coding-Constitution/`
6. `06-Design-Constitution/`
7. `07-Project-Understanding/`

Only after reading these files may the agent begin implementation.

---

## Task-Based Reading Rules

### For UI / UX / Design Tasks

If the task involves:

- Landing Page
- Dashboard
- Admin Panel
- SaaS
- CRUD
- Responsive Design
- Design System
- Component Styling

The agent MUST additionally read:

```text
02-Design-System/
06-Design-Constitution/
99-Quick-Prompts/Design System.md
```

Then load the relevant prompt:

```text
99-Quick-Prompts/Landing Page.md
99-Quick-Prompts/Dashboard.md
99-Quick-Prompts/Admin Panel.md
99-Quick-Prompts/SaaS.md
99-Quick-Prompts/CRUD.md
99-Quick-Prompts/Mobile Responsive.md
```

---

### For Frontend / Backend / Code Tasks

The agent MUST additionally read:

```text
03-Frontend-System/
05-Coding-Constitution/
08-Refactor-Rules/
CURSOR_RULES.md
OPENAI.md
CLAUDE.md
```

---

## Project Understanding Rule

Before editing any project, the agent MUST inspect:

- Project folder structure
- Framework
- Package manager
- Existing components
- Existing routes/pages
- Styling system
- Existing API structure
- Existing database pattern

The agent MUST NOT assume the tech stack without checking.

---

## Coding Rules

The agent MUST:

- Follow the existing project structure
- Follow the coding constitution
- Preserve existing business logic
- Prefer reusable components
- Keep code maintainable
- Keep naming consistent
- Avoid unnecessary dependencies
- Avoid rewriting unrelated files

Priority order:

1. Correctness
2. Maintainability
3. Security
4. Readability
5. Performance
6. Consistency

---

## Design Rules

The agent MUST:

- Follow the design system
- Keep UI modern and clean
- Use consistent spacing
- Maintain responsive layouts
- Use reusable components
- Keep typography readable

Preferred visual style:

- Modern
- Minimal
- Premium
- Clean
- Soft shadows
- Rounded corners
- Subtle gradients
- Green / Blue tone when appropriate

The agent MUST NOT randomly redesign the whole UI.

---

## Refactor Rules

Before refactoring, the agent MUST read:

```text
08-Refactor-Rules/
05-Coding-Constitution/
```

The agent MUST preserve:

- Existing behavior
- Existing routes
- Existing APIs
- Existing database schema
- Existing user-facing text

Unless explicitly requested.

---

## Forbidden Behavior

The agent MUST NOT:

- Start coding before reading AI SKILL
- Ignore project structure
- Randomly change UI style
- Delete files without permission
- Rewrite unrelated files
- Change business logic without request
- Invent APIs or database schema
- Mix unrelated improvements

---

## Completion Rule

After task completion, summarize briefly:

1. What changed
2. Which files changed
3. Why the change was made
4. Any recommended next step

Keep explanations short and practical.

---

## Startup Prompt

Before starting any task:

```text
Read AGENTS.md first.

Then load and read the AI Skill knowledge base from:

C:/Users/OUTLET007/Documents/Obsidian Vault/AI SKILL

Follow this order:

README.md
00-Overview
01-Core-Skill
04-AI-Rules
05-Coding-Constitution
06-Design-Constitution
07-Project-Understanding

For UI/Design tasks:
Read 02-Design-System and relevant files in 99-Quick-Prompts.

For Code tasks:
Read 03-Frontend-System, 08-Refactor-Rules, CURSOR_RULES.md, OPENAI.md, and CLAUDE.md.

Inspect the actual project before editing.
Do not assume framework, routes, styling system, API, or database.

Make only requested changes.
```

---

## Recommended Placement

Put this file in the root of your project:

```text
your-project/
├── src/
├── app/
├── package.json
├── AGENTS.md
```

The AI Skill vault remains here:

```text
C:/Users/OUTLET007/Documents/Obsidian Vault/AI SKILL
```
