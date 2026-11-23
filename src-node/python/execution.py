"""Per-call execution and cleanup for the IFC MCP Pyodide workers."""
import ast
import contextlib
import gc
import inspect
import io
import json
import os
import shutil
import sys
import traceback


async def _ifc_mcp_execute(code, options_json="{}"):
    options = json.loads(options_json)
    script_name = str(options.get("scriptFileName") or ".ifc-mcp-script.py").replace("\\", "/").split("/")[-1]
    if script_name in ("", ".", ".."):
        raise ValueError("Invalid Python script filename")
    script_path = "/home/pyodide/" + script_name
    with open(script_path, "w", encoding="utf-8") as handle:
        handle.write(code)
    namespace = {"__name__": "__main__", "__file__": script_path}
    previous_env = __assistant_apply_environment(json.dumps(options.get("env", {})))
    __assistant_prepare_display_capture()
    stdout, stderr = io.StringIO(), io.StringIO()
    value, status = None, "completed"
    try:
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            tree = ast.parse(code, filename=script_path, mode="exec")
            if tree.body and isinstance(tree.body[-1], ast.Expr):
                tree.body[-1] = ast.copy_location(ast.Assign(
                    targets=[ast.Name(id="_ifc_mcp_value", ctx=ast.Store())],
                    value=tree.body[-1].value), tree.body[-1])
                ast.fix_missing_locations(tree)
            compiled = compile(tree, script_path, "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
            pending = eval(compiled, namespace)
            if inspect.isawaitable(pending):
                await pending
            value = namespace.get("__assistant_result__", namespace.get("result", namespace.get("_ifc_mcp_value")))
    except BaseException:
        status = "error"
        traceback.print_exc(file=stderr)
    finally:
        __assistant_restore_environment(previous_env)
        if not options.get("scriptFileName") and os.path.isfile(script_path):
            os.unlink(script_path)
        # Repeated plots and model references must not accumulate across calls.
        import matplotlib.pyplot as plt
        plt.close("all")
        namespace.clear()
        gc.collect()

    def encode(obj):
        if hasattr(obj, "tolist"):
            return obj.tolist()
        if isinstance(obj, (set, tuple)):
            return list(obj)
        return str(obj)

    return json.dumps({"runtimeStatus": status, "result": value,
                       "stdout": stdout.getvalue(), "stderr": stderr.getvalue(),
                       "displays": __assistant_take_displays()}, default=encode)


def _ifc_mcp_reset_files():
    os.chdir("/")
    shutil.rmtree("/home/pyodide", ignore_errors=True)
    os.makedirs("/home/pyodide", exist_ok=True)
    os.chdir("/home/pyodide")
