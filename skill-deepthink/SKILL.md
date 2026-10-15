---
name: deepthink
description: DeepThink. Use at the start of a task that is not clearly defined — open-ended, higher-level planning, research, strategy or design work where the real goal, inputs or success test are still fuzzy. Before doing the task, finds the deeper (not bigger) version of it and rewrites the user's prompt to ask for exactly that. Trigger on /deepthink, "DeepThink", "think deeper", "תחשוב לעומק", "דיפ ת'ינק".
when_to_use: When a new task begins and it is vague or high-level rather than a concrete, well-specified change (e.g. "plan how we...", "what's the best way to...", "figure out..."). Not for clear, bounded tasks like a specific bug fix or a one-line change. Also fires on the slash command /deepthink.
disable-model-invocation: false
---

# DeepThink

Apply the prompt below to the user's current task, as if the user had sent it about that task.
Answer in the user's language. After the rewritten prompt, ask the user whether to proceed with it before starting the work.

> I want a deeper version of this task, not a bigger one. Before rewriting it: (1) say what a top professional in this field would do here that I'm not asking for; (2) name the rawest material they would start from instead of what has already been digested for me; (3) name the specific methods and tools they would use; (4) say what, other than you or me, would show the result is right. Then rewrite my prompt to ask for exactly that.
