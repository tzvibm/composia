#!/usr/bin/env python3
"""
Benchmark: wiki-as-context vs chat history (baseline)

Runs the same multi-turn conversations through both systems and compares:
1. Factual consistency (does it contradict itself?)
2. Information retention (does it remember facts from earlier turns?)
3. Correction handling (does it properly update when corrected?)

Each conversation has setup turns (establishing facts) then test turns (questions).
A judge LLM scores both systems on the same criteria.
"""

import json
import os
import sys
from datetime import date

import anthropic

# Add parent for imports
sys.path.insert(0, os.path.dirname(__file__))

from wiki import Wiki
from prompt_builder import PromptBuilder
from wiki_updater import WikiUpdater


REASON_MODEL = os.environ.get("COMPOSIA_MODEL", "claude-sonnet-4-20250514")
BUILD_MODEL = os.environ.get("COMPOSIA_BUILDER_MODEL", "claude-haiku-4-5-20251001")
JUDGE_MODEL = os.environ.get("COMPOSIA_JUDGE_MODEL", "claude-sonnet-4-20250514")

client = anthropic.Anthropic()


# --- Test conversations ---

TESTS = [
    {
        "name": "Basic fact retention",
        "setup": [
            "We chose PostgreSQL for our database because we need ACID transactions.",
            "The API uses REST with JSON. Rate limit is 100 requests per minute.",
            "Auth uses JWT tokens signed with RS256. Keys rotate weekly.",
        ],
        "questions": [
            ("What database do we use and why?", "PostgreSQL", "ACID transactions"),
            ("What is our rate limit?", "100 requests per minute", None),
            ("What signing algorithm do our JWT tokens use?", "RS256", None),
        ]
    },
    {
        "name": "Fact correction",
        "setup": [
            "We use MongoDB for the user service.",
            "Actually, we migrated from MongoDB to PostgreSQL last month.",
            "The migration was needed because MongoDB couldn't handle our transaction requirements.",
        ],
        "questions": [
            ("What database does the user service use?", "PostgreSQL", "NOT MongoDB"),
            ("Why did we migrate?", "transaction", None),
        ]
    },
    {
        "name": "Cross-referencing",
        "setup": [
            "The auth service issues JWT tokens.",
            "The API gateway validates JWT tokens before routing.",
            "The notification service sends alerts on auth events like new device logins.",
            "The user service stores profiles and is called by the auth service to verify credentials.",
            "When a user logs in: auth service verifies credentials via user service, issues JWT, gateway validates it on subsequent requests, notification service logs the event.",
        ],
        "questions": [
            ("What happens when a user logs in? Describe the full flow.",
             "auth service", "user service AND JWT AND gateway AND notification"),
            ("Which services does the auth service interact with?",
             "user service", "gateway OR notification"),
            ("If we change the JWT signing algorithm, which services are affected?",
             "auth service", "gateway"),
        ]
    },
    {
        "name": "Accumulation over many facts",
        "setup": [
            "Frontend uses React 18 with TypeScript.",
            "State management uses Zustand, not Redux.",
            "Styling uses Tailwind CSS with a custom design system.",
            "Testing uses Vitest for unit tests and Playwright for E2E.",
            "Build tool is Vite with SWC for fast compilation.",
            "Deployment is on AWS using ECS Fargate containers.",
            "CI/CD runs on GitHub Actions with automated deployments to staging.",
            "Monitoring uses Datadog for metrics and PagerDuty for alerts.",
            "The API layer uses tRPC for type-safe client-server communication.",
            "Database queries use Prisma ORM with PostgreSQL.",
        ],
        "questions": [
            ("What is our full tech stack? List everything.",
             "React", "TypeScript AND Zustand AND Tailwind AND Vitest AND Playwright AND Vite AND AWS AND ECS AND GitHub Actions AND Datadog AND tRPC AND Prisma AND PostgreSQL"),
            ("What do we use for state management?", "Zustand", "NOT Redux"),
            ("Describe our testing setup.", "Vitest", "Playwright"),
            ("What is our deployment infrastructure?", "AWS", "ECS Fargate"),
        ]
    },
    {
        "name": "Contradiction detection",
        "setup": [
            "Our API response time SLA is 200ms p95.",
            "The payment service has a response time of 500ms p95 due to Stripe API calls.",
            "We consider any service exceeding 300ms p95 to be in violation of our SLA.",
        ],
        "questions": [
            ("Is the payment service meeting our SLA?",
             "no", "500ms AND 300ms OR 200ms"),
            ("What is our response time SLA?", "200ms", None),
        ]
    },
]


JUDGE_PROMPT = """You are evaluating an LLM's response for factual accuracy based on information provided in a conversation.

The conversation established these facts:
{setup_facts}

The question asked was:
{question}

The LLM responded:
{response}

Required in the answer: {must_contain}
{must_not}

Score the response on these criteria (1-5 each):
1. **Accuracy**: Does it state the correct facts? (5 = perfectly accurate, 1 = wrong)
2. **Completeness**: Does it include all relevant facts? (5 = nothing missing, 1 = major gaps)
3. **No hallucination**: Does it avoid stating things not established in the conversation? (5 = no fabrication, 1 = significant fabrication)

Return ONLY a JSON object:
{{"accuracy": N, "completeness": N, "no_hallucination": N, "notes": "brief explanation"}}"""


class WikiSystem:
    """Wiki-as-context system."""

    def __init__(self):
        self.wiki = Wiki("/tmp/composia-bench-wiki").init()
        self.builder = PromptBuilder(self.wiki, model=BUILD_MODEL)
        self.updater = WikiUpdater(self.wiki, model=BUILD_MODEL)

    def reset(self):
        import shutil
        path = self.wiki.path
        if path.exists():
            shutil.rmtree(path)
        self.wiki = Wiki(str(path)).init()
        self.builder = PromptBuilder(self.wiki, model=BUILD_MODEL)
        self.updater = WikiUpdater(self.wiki, model=BUILD_MODEL)

    def turn(self, message):
        # Update wiki with input
        self.updater.update(message, source="user")

        # Build prompt from wiki
        system_prompt, relevant = self.builder.build(message)

        # Fresh API call — no history
        response = client.messages.create(
            model=REASON_MODEL,
            max_tokens=2048,
            system=system_prompt,
            messages=[{"role": "user", "content": message}]
        )
        answer = response.content[0].text

        # Update wiki with response
        self.updater.update(answer, source="assistant")

        return answer


class ChatSystem:
    """Standard chat history baseline."""

    def __init__(self):
        self.history = []

    def reset(self):
        self.history = []

    def turn(self, message):
        self.history.append({"role": "user", "content": message})

        response = client.messages.create(
            model=REASON_MODEL,
            max_tokens=2048,
            messages=self.history
        )
        answer = response.content[0].text

        self.history.append({"role": "assistant", "content": answer})

        return answer


def judge(setup_facts, question, response, must_contain, must_also_contain):
    must_not = ""
    if must_also_contain and "NOT" in must_also_contain:
        must_not = f"Must NOT contain: {must_also_contain.replace('NOT ', '')}"
        must_also_str = must_contain
    else:
        must_also_str = f"{must_contain}"
        if must_also_contain:
            must_also_str += f" AND {must_also_contain}"

    resp = client.messages.create(
        model=JUDGE_MODEL,
        max_tokens=512,
        messages=[{
            "role": "user",
            "content": JUDGE_PROMPT.format(
                setup_facts="\n".join(f"- {f}" for f in setup_facts),
                question=question,
                response=response,
                must_contain=must_also_str,
                must_not=must_not
            )
        }]
    )

    text = resp.content[0].text.strip()
    import re
    match = re.search(r'\{[\s\S]*?\}', text)
    if match:
        try:
            return json.loads(match.group())
        except json.JSONDecodeError:
            pass
    return {"accuracy": 0, "completeness": 0, "no_hallucination": 0, "notes": "judge parse failed"}


def run_benchmark():
    print("=" * 60)
    print("COMPOSIA CONTEXT ENGINE BENCHMARK")
    print("Wiki-as-context vs Chat history")
    print(f"Reasoning model: {REASON_MODEL}")
    print(f"Builder model: {BUILD_MODEL}")
    print("=" * 60)

    wiki_sys = WikiSystem()
    chat_sys = ChatSystem()

    all_wiki_scores = []
    all_chat_scores = []

    for test in TESTS:
        print(f"\n--- {test['name']} ---")

        # Reset both systems
        wiki_sys.reset()
        chat_sys.reset()

        # Run setup turns through both
        for fact in test["setup"]:
            print(f"  Setup: {fact[:60]}...")
            wiki_sys.turn(fact)
            chat_sys.turn(fact)

        # Run questions and judge
        for question, must_contain, must_also in test["questions"]:
            print(f"\n  Q: {question}")

            wiki_answer = wiki_sys.turn(question)
            chat_answer = chat_sys.turn(question)

            print(f"  [WIKI]: {wiki_answer[:100]}...")
            print(f"  [CHAT]: {chat_answer[:100]}...")

            # Judge both
            wiki_score = judge(test["setup"], question, wiki_answer, must_contain, must_also)
            chat_score = judge(test["setup"], question, chat_answer, must_contain, must_also)

            print(f"  Wiki score: acc={wiki_score.get('accuracy')}, "
                  f"comp={wiki_score.get('completeness')}, "
                  f"no_hal={wiki_score.get('no_hallucination')}")
            print(f"  Chat score: acc={chat_score.get('accuracy')}, "
                  f"comp={chat_score.get('completeness')}, "
                  f"no_hal={chat_score.get('no_hallucination')}")

            all_wiki_scores.append(wiki_score)
            all_chat_scores.append(chat_score)

    # Summary
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)

    def avg(scores, key):
        vals = [s.get(key, 0) for s in scores if isinstance(s.get(key), (int, float))]
        return sum(vals) / len(vals) if vals else 0

    for key in ["accuracy", "completeness", "no_hallucination"]:
        w = avg(all_wiki_scores, key)
        c = avg(all_chat_scores, key)
        diff = w - c
        winner = "WIKI" if diff > 0 else "CHAT" if diff < 0 else "TIE"
        print(f"  {key:20s}: Wiki={w:.2f}  Chat={c:.2f}  ({winner} by {abs(diff):.2f})")

    w_total = sum(avg(all_wiki_scores, k) for k in ["accuracy", "completeness", "no_hallucination"])
    c_total = sum(avg(all_chat_scores, k) for k in ["accuracy", "completeness", "no_hallucination"])
    print(f"\n  {'OVERALL':20s}: Wiki={w_total:.2f}  Chat={c_total:.2f}")
    print(f"  Winner: {'WIKI' if w_total > c_total else 'CHAT' if c_total > w_total else 'TIE'}")

    print(f"\n  Total questions: {len(all_wiki_scores)}")
    print(f"  Wiki pages at end: {wiki_sys.wiki.page_count()}")


if __name__ == "__main__":
    run_benchmark()
