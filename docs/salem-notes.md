# Salem — the notes, organised

Your notes from the start of the conversation, tidied into groups. Nothing
added, nothing dropped — only reordered and de-duplicated.

Status is tracked in [salem-ai-rewrite.md](salem-ai-rewrite.md).

---

## 1. The AI needs to be able to get at what it already has

The core complaint: it runs dry on information that is right there.

- Notebook chats must be able to ask for a **whole source**, not just the one
  page retrieval happened to return
- The normal chat (outside notebooks) should be able to **create sources** and
  add them to any notebook
- More ways for the AI to fetch its own context, generally

## 2. Quizzes

**Generating**

- Choose the **question types** to include — multiple choice, fill in the
  blank, multiple select — or tick exactly the ones you want
- **Difficulty** options when generating
- Generate **in the background**: no modal left open, a card appears in the
  Quizzes section straight away, showing as loading
- Remember the **last options used** in the generate modal (not the extra steps)

**The questions themselves**

- The multiple-choice answer is always the first option — fix it
- **Hints on every question type**, subtle but genuinely helpful
- Proper **fill in the blank**: a gap in the middle of the sentence you type
  into, with a hint button
- Show the **source** each question came from
- Maths in the **answer options** is not rendering

**Playing**

- **See every question before starting** the quiz
- **Save progress**

**Under the hood**

- It runs Python to check biology questions, which makes no sense — optimise
  per subject

## 3. Flashcards

- One **single point per card** — not broad, multi-part questions; that is
  what the quiz is for
- Deck size should mean something:
  **fewer** = main points only, **standard** = most of it,
  **more** = everything in the selected sources, capped at 100
- Cards in **source order** unless shuffle is on
- Remember the **shuffle setting globally**, across every notebook and deck,
  when reopening a deck
- Show the **source** each card came from
- **Difficulty** options when generating
- Generate **in the background**, same as quizzes
- **Save progress**
- General improvement — they need work

## 4. The model

- Optimise it for **STEM**, for **biology**, and for **business** separately —
  all three should be equally good, and everything else should stay good

## 5. Web search

- Available in the **normal chat**, freely — preferred, in fact, for accuracy
- In **notebook chat**, only when the question actually needs it
- **Never** for flashcards or quizzes — those use the sources only

## 6. Schedule and the Assignment Solver

- **Cache assignment due dates**, so the Schedule shows them without the
  Tampermonkey script running
- Refresh the cache next time the Assignment Solver is opened

## 7. Activity

- Click a **day** in the activity page to see which notebooks and subjects
  were studied that day

## 8. Onboarding

- A page that appears when **dependencies are missing** — Tectonic, Python —
  with buttons that install them
- For Python, set up the **virtualenv** too

## 9. Tab mode

- Run as a **localhost server** you can open in a browser tab, instead of only
  as an app
- The same app, the same UI, shown in the tab
- A **button in the sidebar** that turns it on and shows the link
