# Project Rules

## STOP WASTING TOKENS — Hard Limits

### When the user says something LOOKS wrong visually:
1. **DO NOT trace ROM disassembly.** DO NOT analyze hex offsets. DO NOT read bank data.
2. **Find or ask for a reference image IMMEDIATELY.** Download it. Analyze pixels with python/PIL.
3. **Compare reference pixels against our rendering.** Derive the correct values from the image.
4. **Apply the fix. Done.** Maximum 3 tool calls from "it looks wrong" to fix applied.

### The 3-strike rule:
- If you have made 3 tool calls trying to verify/prove something and still don't have the answer: **STOP.**
- Do NOT make a 4th attempt with a slightly different approach.
- Instead: ask the user, find a reference image, or try the simplest possible fix.

### NEVER do these:
- Spend more than 3 tool calls tracing ROM disassembly for a visual issue
- Launch research agents to "verify" data when the user already told you the answer
- Argue with the user about what something should look like — THEY KNOW, YOU DON'T
- Web search for sprite references when you can just download the actual sprite and analyze it
- Re-verify data you already verified — if it was wrong the first time, your METHOD is wrong

### The user is the source of truth for visual correctness. The ROM is not.
