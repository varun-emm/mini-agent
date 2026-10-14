#!/usr/bin/env python3
"""
Mini Agent - a small agentic chatbot running on Groq.

This file IS the "harness": the software wrapped around the model.
The model only writes text. This program:
  1. sends your message + the list of tools to the model      (THINK)
  2. runs whatever tool the model asks for                     (ACT)
  3. pastes the tool's result back into the conversation       (OBSERVE)
  4. repeats until the model replies without asking for a tool (CHECK -> DONE)

Run:   python agent.py
Needs: pip install groq ddgs requests
       GROQ_API_KEY set in your environment (see README.md)
"""

import ast
import datetime
import json
import math
import operator
import os
import re
import subprocess
import sys
from pathlib import Path

try:
    from groq import Groq
except ImportError:
    sys.exit("Missing package. Run:  pip install groq ddgs requests")

# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------
MODEL = os.environ.get("AGENT_MODEL", "openai/gpt-oss-120b")  # the "brain"
MAX_STEPS = 15              # safety brake: max loop rounds per message
MAX_TOOL_OUTPUT = 6000      # characters of tool output shown to the model
MAX_HISTORY_CHARS = 60000   # rough context budget before old turns are dropped
WORKSPACE = Path(__file__).resolve().parent / "workspace"   # the agent's sandbox folder
WORKSPACE.mkdir(exist_ok=True)
AUTO_APPROVE_CODE = os.environ.get("AGENT_AUTO_APPROVE") == "1"


# ---------------------------------------------------------------------------
# Pretty printing (so you can watch the loop happen)
# ---------------------------------------------------------------------------
class C:
    DIM = "\033[2m"
    CYAN = "\033[36m"
    YELLOW = "\033[33m"
    GREEN = "\033[32m"
    RED = "\033[31m"
    BOLD = "\033[1m"
    END = "\033[0m"


if os.name == "nt":          # enable colours on Windows terminals
    os.system("")


def show(label, text, colour=C.DIM, limit=400):
    text = str(text).strip()
    if len(text) > limit:
        text = text[:limit] + " ..."
    print(f"{colour}[{label}] {text}{C.END}")


# ---------------------------------------------------------------------------
# TOOLS - the agent's "hands". Each is a normal Python function.
# ---------------------------------------------------------------------------
def truncate(text, limit=MAX_TOOL_OUTPUT):
    text = str(text)
    return text if len(text) <= limit else text[:limit] + f"\n...[truncated, {len(text) - limit} more chars]"


def safe_path(name):
    """Keep every file operation inside the workspace folder."""
    path = (WORKSPACE / name).resolve()
    if WORKSPACE != path and WORKSPACE not in path.parents:
        raise ValueError("Path must stay inside the workspace folder.")
    return path


def web_search(query, max_results=5):
    try:
        from ddgs import DDGS
    except ImportError:
        try:
            from duckduckgo_search import DDGS
        except ImportError:
            return "web_search unavailable. Install it with: pip install ddgs"
    results = DDGS().text(query, max_results=int(max_results))
    clean = [{"title": r.get("title"), "url": r.get("href"), "snippet": r.get("body")} for r in results]
    return json.dumps(clean, ensure_ascii=False, indent=1) if clean else "No results."


def fetch_webpage(url):
    import requests
    resp = requests.get(url, timeout=20, headers={"User-Agent": "Mozilla/5.0 (MiniAgent)"})
    resp.raise_for_status()
    html = resp.text
    html = re.sub(r"(?is)<(script|style|noscript|svg).*?</\1>", " ", html)
    text = re.sub(r"(?s)<[^>]+>", " ", html)
    text = re.sub(r"&nbsp;", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return truncate(text)


_OPS = {
    ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
    ast.Div: operator.truediv, ast.FloorDiv: operator.floordiv, ast.Mod: operator.mod,
    ast.Pow: operator.pow, ast.USub: operator.neg, ast.UAdd: operator.pos,
}
_FUNCS = {"sqrt": math.sqrt, "round": round, "abs": abs, "min": min, "max": max,
          "log": math.log, "log10": math.log10, "exp": math.exp, "ceil": math.ceil, "floor": math.floor}


def calculator(expression):
    """Safe maths: numbers, + - * / // % **, brackets, and a few functions."""
    def ev(node):
        if isinstance(node, ast.Expression):
            return ev(node.body)
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
            return node.value
        if isinstance(node, ast.BinOp) and type(node.op) in _OPS:
            return _OPS[type(node.op)](ev(node.left), ev(node.right))
        if isinstance(node, ast.UnaryOp) and type(node.op) in _OPS:
            return _OPS[type(node.op)](ev(node.operand))
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in _FUNCS:
            return _FUNCS[node.func.id](*[ev(a) for a in node.args])
        raise ValueError("Unsupported expression.")
    expression = expression.replace(",", "") if re.fullmatch(r"[\d,.\s+\-*/()%]+", expression) else expression
    return str(ev(ast.parse(expression, mode="eval")))


def run_python(code):
    """Run Python code in the workspace folder (asks you first)."""
    print(f"{C.YELLOW}--- The agent wants to run this code ---{C.END}\n{code}\n{C.YELLOW}----------------------------------------{C.END}")
    if not AUTO_APPROVE_CODE:
        ok = input(f"{C.YELLOW}Allow? [y/N] {C.END}").strip().lower()
        if ok not in ("y", "yes"):
            return "User declined to run this code. Ask them or try another approach."
    script = WORKSPACE / "_agent_run.py"
    script.write_text(code, encoding="utf-8")
    try:
        proc = subprocess.run([sys.executable, script.name], cwd=WORKSPACE,
                              capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired:
        return "Error: code took longer than 60 seconds and was stopped."
    out = f"exit code: {proc.returncode}\nstdout:\n{proc.stdout}\nstderr:\n{proc.stderr}"
    return truncate(out)


def write_file(path, content):
    p = safe_path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")
    return f"Wrote {len(content)} characters to workspace/{path}"


def read_file(path):
    return truncate(safe_path(path).read_text(encoding="utf-8", errors="replace"))


def list_files(path="."):
    base = safe_path(path)
    items = [str(p.relative_to(WORKSPACE)) + ("/" if p.is_dir() else "")
             for p in sorted(base.rglob("*")) if not p.name.startswith("_agent_run")]
    return "\n".join(items) if items else "(workspace is empty)"


def get_current_time():
    return datetime.datetime.now().astimezone().strftime("%A, %d %B %Y, %H:%M %Z (UTC%z)")


TOOL_FUNCTIONS = {
    "web_search": web_search,
    "fetch_webpage": fetch_webpage,
    "calculator": calculator,
    "run_python": run_python,
    "write_file": write_file,
    "read_file": read_file,
    "list_files": list_files,
    "get_current_time": get_current_time,
}


# Tool "menus" sent to the model. The description is how the model decides WHEN to use each tool.
def _tool(name, description, props=None, required=None):
    return {"type": "function", "function": {
        "name": name, "description": description,
        "parameters": {"type": "object", "properties": props or {}, "required": required or []}}}


TOOLS = [
    _tool("web_search", "Search the web. Use for anything current, factual, or that you are unsure about.",
          {"query": {"type": "string"}, "max_results": {"type": "integer", "description": "1-10, default 5"}}, ["query"]),
    _tool("fetch_webpage", "Read the text of a web page. Use after web_search when snippets are not enough.",
          {"url": {"type": "string"}}, ["url"]),
    _tool("calculator", "Exact arithmetic, e.g. '125000 * 0.18'. Use instead of doing maths in your head.",
          {"expression": {"type": "string"}}, ["expression"]),
    _tool("run_python", "Run a Python script in the workspace folder and get stdout/stderr. Use for data work, "
          "multi-step calculations, or testing code you wrote. Print anything you need to see.",
          {"code": {"type": "string"}}, ["code"]),
    _tool("write_file", "Create or overwrite a text file in the workspace folder.",
          {"path": {"type": "string"}, "content": {"type": "string"}}, ["path", "content"]),
    _tool("read_file", "Read a text file from the workspace folder.", {"path": {"type": "string"}}, ["path"]),
    _tool("list_files", "List files in the workspace folder.", {"path": {"type": "string"}}),
    _tool("get_current_time", "Get the current local date and time."),
]


def execute_tool(name, raw_args):
    """The harness actually runs the tool the model asked for."""
    func = TOOL_FUNCTIONS.get(name)
    if func is None:
        return f"Error: unknown tool '{name}'. Available: {', '.join(TOOL_FUNCTIONS)}"
    try:
        args = json.loads(raw_args) if raw_args else {}
        if not isinstance(args, dict):
            raise ValueError("arguments must be a JSON object")
    except Exception as e:
        return f"Error: could not read tool arguments ({e}). Send valid JSON."
    try:
        return truncate(func(**args))
    except Exception as e:  # errors go BACK to the model so it can fix its approach
        return f"Error while running {name}: {type(e).__name__}: {e}"


# ---------------------------------------------------------------------------
# SYSTEM PROMPT - the standing instructions that shape the agent's behaviour
# ---------------------------------------------------------------------------
def system_prompt():
    return f"""You are Mini Agent, a capable assistant that completes tasks by working in a loop:
think about the next step, use a tool, look at the result, and repeat until the task is truly done.

Current date and time: {get_current_time()}

How to work:
- For anything about the present (prices, news, who holds a role, latest versions), use web_search first. Do not rely on memory.
- For any number that matters, use calculator or run_python. Never do important maths in your head.
- When you write code or a file, verify it: run it, or read it back, before saying it is done.
- If a tool returns an error, read it, fix your approach, and try again. Do not repeat the exact same failing call.
- Files live only in the workspace folder.
- Ask the user a question only when you truly cannot proceed without their input.

When finished, give a clear, concise final answer. Briefly say what you checked, and list source URLs if you used the web."""


# ---------------------------------------------------------------------------
# CONTEXT MANAGEMENT - keep the conversation within the model's working memory
# ---------------------------------------------------------------------------
def trim_history(messages):
    """Drop the oldest whole user turns when the history gets too long (simple context compaction)."""
    def size():
        return sum(len(json.dumps(m, default=str)) for m in messages)
    dropped = 0
    while size() > MAX_HISTORY_CHARS:
        user_idx = [i for i, m in enumerate(messages) if m["role"] == "user"]
        if len(user_idx) < 2:
            break
        del messages[user_idx[0]:user_idx[1]]   # remove oldest turn and its tool traffic
        dropped += 1
    if dropped:
        show("context", f"Dropped {dropped} old turn(s) to stay within the context window.", C.DIM)


# ---------------------------------------------------------------------------
# THE AGENT LOOP
# ---------------------------------------------------------------------------
def run_agent_turn(client, messages):
    messages[0] = {"role": "system", "content": system_prompt()}   # refresh the clock each turn
    bad_calls = 0

    for step in range(1, MAX_STEPS + 1):
        # THINK: send everything so far, plus the tool menu
        try:
            resp = client.chat.completions.create(
                model=MODEL, messages=messages, tools=TOOLS, tool_choice="auto", temperature=0.3)
        except Exception as e:
            err = str(e)
            if "tool_use_failed" in err and bad_calls < 2:   # model produced a malformed tool call
                bad_calls += 1
                show("harness", "Model sent a malformed tool call, asking it to retry.", C.RED)
                messages.append({"role": "user", "content":
                                 "[harness note] Your last tool call was malformed and was not run. "
                                 "Retry with valid JSON arguments that match the tool's schema."})
                continue
            show("error", err, C.RED, limit=800)
            return

        msg = resp.choices[0].message
        reasoning = getattr(msg, "reasoning", None)
        if reasoning:
            show(f"think {step}", reasoning, C.DIM)

        # ACT + OBSERVE: model asked for tools -> run them, feed results back, loop again
        if msg.tool_calls:
            if msg.content:
                show(f"note {step}", msg.content, C.DIM)
            messages.append({
                "role": "assistant",
                "content": msg.content,
                "tool_calls": [{"id": tc.id, "type": "function",
                                "function": {"name": tc.function.name, "arguments": tc.function.arguments}}
                               for tc in msg.tool_calls],
            })
            for tc in msg.tool_calls:
                show(f"act {step}", f"{tc.function.name}({tc.function.arguments})", C.CYAN)
                result = execute_tool(tc.function.name, tc.function.arguments)
                show(f"observe {step}", result, C.DIM, limit=300)
                messages.append({"role": "tool", "tool_call_id": tc.id, "content": result})
            continue

        # CHECK -> DONE: no tool requested means the model considers the task finished
        answer = msg.content or "(no answer)"
        messages.append({"role": "assistant", "content": answer})
        print(f"\n{C.GREEN}{C.BOLD}Agent:{C.END} {answer}\n")
        return

    # Safety brake hit
    note = f"Stopped after {MAX_STEPS} steps without finishing. Say 'continue' to let it keep going."
    messages.append({"role": "assistant", "content": note})
    print(f"\n{C.YELLOW}{note}{C.END}\n")


# ---------------------------------------------------------------------------
# CHAT INTERFACE
# ---------------------------------------------------------------------------
def main():
    if not os.environ.get("GROQ_API_KEY"):
        sys.exit("GROQ_API_KEY is not set. See README.md for how to add your key.")
    client = Groq()
    messages = [{"role": "system", "content": system_prompt()}]

    print(f"{C.BOLD}Mini Agent{C.END} on {MODEL}. Files go in: {WORKSPACE}")
    print("Commands: /tools  /reset  /quit\n")
    while True:
        try:
            user = input(f"{C.BOLD}You:{C.END} ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if not user:
            continue
        if user in ("/quit", "/exit"):
            break
        if user == "/reset":
            messages = [{"role": "system", "content": system_prompt()}]
            print("Conversation cleared.\n")
            continue
        if user == "/tools":
            for t in TOOLS:
                print(f"  - {t['function']['name']}: {t['function']['description']}")
            print()
            continue
        trim_history(messages)
        checkpoint = len(messages)
        messages.append({"role": "user", "content": user})
        try:
            run_agent_turn(client, messages)
        except KeyboardInterrupt:
            del messages[checkpoint:]   # undo the half-finished turn so the history stays valid
            print(f"\n{C.YELLOW}Interrupted. That request was discarded.{C.END}\n")


if __name__ == "__main__":
    main()
