#!/usr/bin/env python3
"""
Composia Context Engine MVP

Wiki-as-context agent loop using the Anthropic API.
Each turn: update wiki → build prompt from wiki → fresh API call → update wiki.
No chat history. The wiki IS the context.
"""

import os
import sys

import anthropic

from wiki import Wiki
from prompt_builder import PromptBuilder
from wiki_updater import WikiUpdater


WIKI_PATH = os.environ.get("COMPOSIA_WIKI", ".composia/wiki")
REASON_MODEL = os.environ.get("COMPOSIA_MODEL", "claude-sonnet-4-20250514")
BUILD_MODEL = os.environ.get("COMPOSIA_BUILDER_MODEL", "claude-haiku-4-5-20251001")


def main():
    # Init wiki
    wiki = Wiki(WIKI_PATH).init().load()
    builder = PromptBuilder(wiki, model=BUILD_MODEL)
    updater = WikiUpdater(wiki, model=BUILD_MODEL)
    client = anthropic.Anthropic()

    print("Composia Context Engine MVP")
    print(f"Wiki: {WIKI_PATH} ({wiki.page_count()} pages)")
    print("Each turn: wiki → prompt → fresh LLM call → wiki update")
    print("No chat history. The wiki is the context.")
    print()
    print("Commands: 'quit', 'wiki' (show pages), 'dump' (show full prompt)")
    print()

    turn = 0
    last_prompt = ""

    while True:
        try:
            user_input = input("You: ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nDone.")
            break

        if not user_input:
            continue

        if user_input == "quit":
            print(f"Session ended. Wiki has {wiki.page_count()} pages.")
            break

        if user_input == "wiki":
            print(f"\n{wiki.page_count()} pages:")
            for slug, page in wiki.pages.items():
                summary = page.summary or page.content[:60].replace('\n', ' ')
                print(f"  {slug}: {summary}")
            print()
            continue

        if user_input == "dump":
            print(f"\n--- LAST PROMPT ({len(last_prompt)} chars) ---")
            print(last_prompt[:3000])
            if len(last_prompt) > 3000:
                print(f"\n... ({len(last_prompt) - 3000} more chars)")
            print("--- END ---\n")
            continue

        turn += 1

        # Step 1: Update wiki with user input
        print(f"[Turn {turn}: decomposing input into wiki...]")
        user_update = updater.update(user_input, source="user")

        # Step 2: Build prompt from wiki
        print(f"[Building context from wiki ({wiki.page_count()} pages)...]")
        system_prompt, relevant = builder.build(user_input)
        last_prompt = system_prompt

        relevant_str = ", ".join(relevant) if relevant else "none"
        print(f"[Relevant pages: {relevant_str}]")

        # Step 3: Fresh API call — NO chat history, just wiki context + this message
        response = client.messages.create(
            model=REASON_MODEL,
            max_tokens=4096,
            system=system_prompt,
            messages=[{
                "role": "user",
                "content": user_input
            }]
        )
        answer = response.content[0].text

        # Step 4: Update wiki with LLM response
        response_update = updater.update(answer, source="assistant")

        # Show result
        total_updated = (user_update.get("pages_updated", 0) +
                         response_update.get("pages_updated", 0))
        print(f"[Wiki: {wiki.page_count()} pages | {total_updated} updated this turn]\n")
        print(f"Assistant: {answer}\n")


if __name__ == "__main__":
    main()
