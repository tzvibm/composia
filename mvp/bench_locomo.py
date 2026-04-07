#!/usr/bin/env python3
"""
Industry benchmark: LoCoMo (Long Conversation Memory)
https://github.com/snap-research/locomo

This is the standard benchmark used by Mem0, Zep, and other memory systems.
10 conversations, ~200 QA pairs each, 19 sessions per conversation.

We run the same QA against:
1. Wiki-as-context (our system)
2. Chat history baseline (standard approach)
3. Full context stuffing (all sessions in one prompt)

Then use LLM-as-judge to score accuracy (same methodology as Mem0's paper).
"""

import json
import os
import sys
import shutil
import time
from pathlib import Path

import anthropic

sys.path.insert(0, os.path.dirname(__file__))

from wiki import Wiki
from prompt_builder import PromptBuilder
from wiki_updater import WikiUpdater


LOCOMO_PATH = os.environ.get("LOCOMO_DATA", "/tmp/locomo/data/locomo10.json")
REASON_MODEL = os.environ.get("COMPOSIA_MODEL", "claude-sonnet-4-20250514")
BUILD_MODEL = os.environ.get("COMPOSIA_BUILDER_MODEL", "claude-haiku-4-5-20251001")
WIKI_PATH = "/tmp/composia-locomo-wiki"

# How many conversations to test (1-10)
MAX_CONVS = int(os.environ.get("LOCOMO_MAX_CONVS", "1"))
# How many QA pairs per conversation (0 = all)
MAX_QA = int(os.environ.get("LOCOMO_MAX_QA", "20"))

client = anthropic.Anthropic()


JUDGE_PROMPT = """You are evaluating an answer against a ground truth. Score the answer's accuracy.

Question: {question}
Ground truth answer: {ground_truth}
System's answer: {answer}

Score 1-5:
5 = Perfectly matches ground truth
4 = Mostly correct with minor gaps
3 = Partially correct
2 = Mostly wrong but has some correct element
1 = Completely wrong or irrelevant

Return ONLY a JSON object: {{"score": N, "reason": "brief explanation"}}"""


def load_locomo():
    with open(LOCOMO_PATH) as f:
        return json.load(f)


def get_conversation_turns(conv):
    """Extract all turns from all sessions in order."""
    c = conv["conversation"]
    all_turns = []

    session_num = 1
    while True:
        key = f"session_{session_num}"
        date_key = f"session_{session_num}_date_time"

        if key not in c:
            break

        session_date = c.get(date_key, f"Session {session_num}")
        turns = c[key]

        for turn in turns:
            all_turns.append({
                "speaker": turn["speaker"],
                "text": turn["text"],
                "dia_id": turn.get("dia_id", ""),
                "session": session_num,
                "session_date": session_date,
            })

        session_num += 1

    return all_turns


def judge_answer(question, ground_truth, answer):
    """LLM-as-judge scoring (same methodology as Mem0 paper)."""
    try:
        resp = client.messages.create(
            model=BUILD_MODEL,  # Use Haiku for judging (fast + cheap)
            max_tokens=256,
            messages=[{
                "role": "user",
                "content": JUDGE_PROMPT.format(
                    question=question,
                    ground_truth=ground_truth,
                    answer=answer
                )
            }]
        )
        text = resp.content[0].text.strip()
        import re
        match = re.search(r'\{[\s\S]*?\}', text)
        if match:
            return json.loads(match.group())
    except Exception as e:
        print(f"    Judge error: {e}")
    return {"score": 0, "reason": "judge failed"}


def run_wiki_system(turns, qa_pairs):
    """Run QA against wiki-as-context system."""
    # Reset wiki
    if Path(WIKI_PATH).exists():
        shutil.rmtree(WIKI_PATH)

    wiki = Wiki(WIKI_PATH).init()
    builder = PromptBuilder(wiki, model=BUILD_MODEL)
    updater = WikiUpdater(wiki, model=BUILD_MODEL)

    # Ingest all conversation turns into wiki
    print("  Ingesting conversation into wiki...")
    for i, turn in enumerate(turns):
        msg = f"[{turn['session_date']}] {turn['speaker']}: {turn['text']}"
        updater.update(msg, source="conversation")
        if (i + 1) % 50 == 0:
            print(f"    Ingested {i+1}/{len(turns)} turns ({wiki.page_count()} pages)")

    print(f"  Wiki built: {wiki.page_count()} pages")

    # Answer questions using wiki as context
    scores = []
    for i, qa in enumerate(qa_pairs):
        question = qa["question"]
        ground_truth = qa["answer"]

        # Build prompt from wiki
        system_prompt, relevant = builder.build(question)

        # Fresh API call
        resp = client.messages.create(
            model=REASON_MODEL,
            max_tokens=512,
            system=system_prompt,
            messages=[{"role": "user", "content": question}]
        )
        answer = resp.content[0].text

        # Judge
        score = judge_answer(question, ground_truth, answer)
        scores.append(score)
        print(f"    Q{i+1}: {question[:50]}... → score={score.get('score', 0)}")

    return scores


def run_chat_baseline(turns, qa_pairs):
    """Run QA against chat history baseline — stuff all turns + question."""
    # Build conversation as messages
    conv_text = "\n".join(
        f"[{t['session_date']}] {t['speaker']}: {t['text']}"
        for t in turns
    )

    scores = []
    for i, qa in enumerate(qa_pairs):
        question = qa["question"]
        ground_truth = qa["answer"]

        # Send full conversation + question
        resp = client.messages.create(
            model=REASON_MODEL,
            max_tokens=512,
            system="You are answering questions about a conversation you observed. Use only the conversation provided.",
            messages=[{
                "role": "user",
                "content": f"Here is the conversation:\n\n{conv_text}\n\nQuestion: {question}"
            }]
        )
        answer = resp.content[0].text

        score = judge_answer(question, ground_truth, answer)
        scores.append(score)
        print(f"    Q{i+1}: {question[:50]}... → score={score.get('score', 0)}")

    return scores


def main():
    print("=" * 60)
    print("LoCoMo BENCHMARK: Wiki-as-Context vs Chat History")
    print(f"Model: {REASON_MODEL} | Builder: {BUILD_MODEL}")
    print(f"Testing {MAX_CONVS} conversation(s), {MAX_QA} QA pairs each")
    print("=" * 60)

    data = load_locomo()

    all_wiki_scores = []
    all_chat_scores = []

    for conv_idx in range(min(MAX_CONVS, len(data))):
        conv = data[conv_idx]
        turns = get_conversation_turns(conv)
        qa_pairs = conv["qa"][:MAX_QA] if MAX_QA > 0 else conv["qa"]

        print(f"\n--- Conversation {conv_idx + 1} ({conv['sample_id']}) ---")
        print(f"  {len(turns)} turns across {max(t['session'] for t in turns)} sessions")
        print(f"  {len(qa_pairs)} questions to answer")

        # Run wiki system
        print(f"\n  [WIKI SYSTEM]")
        wiki_scores = run_wiki_system(turns, qa_pairs)
        all_wiki_scores.extend(wiki_scores)

        # Run chat baseline
        print(f"\n  [CHAT BASELINE]")
        chat_scores = run_chat_baseline(turns, qa_pairs)
        all_chat_scores.extend(chat_scores)

    # Summary
    print("\n" + "=" * 60)
    print("RESULTS")
    print("=" * 60)

    def avg_score(scores):
        vals = [s.get("score", 0) for s in scores if isinstance(s.get("score"), (int, float))]
        return sum(vals) / len(vals) if vals else 0

    wiki_avg = avg_score(all_wiki_scores)
    chat_avg = avg_score(all_chat_scores)

    print(f"  Wiki-as-context:  {wiki_avg:.2f} / 5.00")
    print(f"  Chat history:     {chat_avg:.2f} / 5.00")
    print(f"  Difference:       {wiki_avg - chat_avg:+.2f}")
    print(f"  Winner:           {'WIKI' if wiki_avg > chat_avg else 'CHAT' if chat_avg > wiki_avg else 'TIE'}")
    print(f"\n  Total questions:  {len(all_wiki_scores)}")


if __name__ == "__main__":
    main()
