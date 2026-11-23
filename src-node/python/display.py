import sys, types, base64, json, io, os, uuid

_ASSISTANT_DISPLAY_READY = globals().get("_ASSISTANT_DISPLAY_READY", False)
if not _ASSISTANT_DISPLAY_READY:
    _ASSISTANT_DISPLAY_RECORDS = []
    _ASSISTANT_DISPLAY_STAGE_DIR = "/home/pyodide/.assistant-display"
    _ASSISTANT_DISPLAY_STAGE_LIMIT = 1024 * 1024
    _ASSISTANT_DISPLAY_STAGE_EXTENSIONS = {
        "text/html": ".html",
        "image/svg+xml": ".svg",
        "application/vnd.plotly.v1+json": ".json",
        "application/vnd.plotly.v2+json": ".json",
    }

    def _assistant__ensure_display_stage_dir():
        try:
            os.makedirs(_ASSISTANT_DISPLAY_STAGE_DIR, exist_ok=True)
        except Exception:
            pass

    def _assistant__clear_display_stage_dir():
        _assistant__ensure_display_stage_dir()
        try:
            for name in os.listdir(_ASSISTANT_DISPLAY_STAGE_DIR):
                path = os.path.join(_ASSISTANT_DISPLAY_STAGE_DIR, name)
                try:
                    if os.path.isfile(path):
                        os.unlink(path)
                except Exception:
                    pass
        except Exception:
            pass

    def _assistant__normalize(value):
        if isinstance(value, (bytes, bytearray)):
            return base64.b64encode(value).decode("ascii")
        if hasattr(value, "tolist"):
            try:
                return value.tolist()
            except Exception:
                pass
        return value

    def _assistant__mimebundle(obj):
        bundle = {}
        try:
            fn = getattr(obj, "_repr_mimebundle_", None)
            if callable(fn):
                data = fn()
                if isinstance(data, tuple):
                    data = (data[0] or {})
                if isinstance(data, dict):
                    for key, val in data.items():
                        if isinstance(key, str):
                            bundle[key] = _assistant__normalize(val)
        except Exception:
            pass

        def add(key, attr):
            if key in bundle:
                return
            value = getattr(obj, attr, None)
            if callable(value):
                try:
                    result = value()
                    if result is not None:
                        bundle[key] = _assistant__normalize(result)
                except Exception:
                    pass

        add("text/html", "_repr_html_")
        add("text/markdown", "_repr_markdown_")
        add("image/svg+xml", "_repr_svg_")
        add("image/png", "_repr_png_")
        add("image/jpeg", "_repr_jpeg_")

        if "image/png" not in bundle:
            try:
                from matplotlib.figure import Figure as _AssistantFigure  # type: ignore
                from matplotlib.backends.backend_agg import FigureCanvasAgg  # type: ignore
                if isinstance(obj, _AssistantFigure):
                    if getattr(obj, "canvas", None) is None:
                        try:
                            FigureCanvasAgg(obj)
                        except Exception:
                            pass
                    buffer = io.BytesIO()
                    try:
                        obj.savefig(buffer, format="png", bbox_inches="tight")
                        bundle["image/png"] = base64.b64encode(buffer.getvalue()).decode("ascii")
                    finally:
                        buffer.close()
            except Exception:
                pass

        if "application/vnd.plotly.v1+json" not in bundle:
            try:
                from plotly.basedatatypes import BaseFigure  # type: ignore
                if isinstance(obj, BaseFigure):
                    bundle["application/vnd.plotly.v1+json"] = obj.to_json()
            except Exception:
                pass

        if "text/plain" not in bundle:
            try:
                bundle["text/plain"] = repr(obj)
            except Exception:
                try:
                    bundle["text/plain"] = str(obj)
                except Exception:
                    bundle["text/plain"] = "<unrepresentable object>"
        return bundle

    def _assistant__stage_display_payload(key, value):
        extension = _ASSISTANT_DISPLAY_STAGE_EXTENSIONS.get(key)
        if extension is None:
            return value
        if isinstance(value, str):
            encoding = "utf-8"
            if len(value) < _ASSISTANT_DISPLAY_STAGE_LIMIT:
                return value
        elif isinstance(value, (bytes, bytearray)):
            payload = bytes(value)
            encoding = "binary"
            if len(payload) < _ASSISTANT_DISPLAY_STAGE_LIMIT:
                return value
        else:
            return value
        _assistant__ensure_display_stage_dir()
        path = os.path.join(_ASSISTANT_DISPLAY_STAGE_DIR, f"display-{uuid.uuid4().hex}{extension}")
        if isinstance(value, str):
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(value)
            size = os.path.getsize(path)
        else:
            with open(path, "wb") as handle:
                handle.write(payload)
            size = len(payload)
        return {
            "__assistant_display_ref__": True,
            "path": path,
            "mime": key,
            "encoding": encoding,
            "size": size,
        }

    def _assistant__display(*objs, metadata=None, **kwargs):
        meta = metadata.copy() if isinstance(metadata, dict) else {}
        if not objs:
            _ASSISTANT_DISPLAY_RECORDS.append({"data": {"text/plain": ""}, "metadata": meta})
            return
        for obj in objs:
            _ASSISTANT_DISPLAY_RECORDS.append({
                "data": _assistant__mimebundle(obj),
                "metadata": meta,
            })

    def _assistant__clear_output(wait=False):
        _ASSISTANT_DISPLAY_RECORDS.clear()

    def __assistant_prepare_display_capture():
        _assistant__clear_display_stage_dir()
        _ASSISTANT_DISPLAY_RECORDS.clear()

    def __assistant_take_displays():
        items = list(_ASSISTANT_DISPLAY_RECORDS)
        _ASSISTANT_DISPLAY_RECORDS.clear()
        sanitized = []
        for item in items:
            data = item.get("data") if isinstance(item, dict) else None
            if not isinstance(data, dict):
                data = {}
            safe_data = {}
            for key, value in list(data.items()):
                if isinstance(value, (str, int, float, bool)) or value is None:
                    normalized = value
                else:
                    normalized = _assistant__normalize(value) if not isinstance(value, (dict, list)) else value
                    if isinstance(normalized, (dict, list)):
                        try:
                            normalized = json.dumps(normalized)
                        except Exception:
                            normalized = str(normalized)
                safe_data[key] = _assistant__stage_display_payload(key, normalized)
            metadata_value = item.get("metadata") if isinstance(item, dict) else None
            metadata_dict = metadata_value if isinstance(metadata_value, dict) else {}
            sanitized.append({"data": safe_data, "metadata": metadata_dict})
        return sanitized

    def __assistant_apply_environment(env_json):
        if not env_json:
            return {}
        try:
            env_values = json.loads(env_json)
        except Exception:
            env_values = {}
        if not isinstance(env_values, dict):
            env_values = {}

        previous = {}
        for key, value in env_values.items():
            key = str(key)
            previous[key] = os.environ.get(key)
            os.environ[key] = "" if value is None else str(value)
        return previous

    def __assistant_restore_environment(previous):
        if not isinstance(previous, dict):
            return
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[str(key)] = str(value)

    def _assistant__ensure_ipython_display():
        ipy = sys.modules.get("IPython")
        if ipy is None:
            ipy = types.ModuleType("IPython")
            sys.modules["IPython"] = ipy
        display_mod = sys.modules.get("IPython.display")
        if display_mod is None or not getattr(display_mod, "__assistant_patch__", False):
            display_mod = types.ModuleType("IPython.display")
            display_mod.display = _assistant__display
            display_mod.clear_output = _assistant__clear_output

            class HTML:
                def __init__(self, data):
                    self.data = data
                def _repr_html_(self):
                    return str(self.data)
                def __repr__(self):
                    return str(self.data)

            class Markdown:
                def __init__(self, data):
                    self.data = data
                def _repr_markdown_(self):
                    return str(self.data)
                def __repr__(self):
                    return str(self.data)

            class Image:
                def __init__(self, data=None, url=None, format=None):
                    self.data = data
                    self.url = url
                    self.format = (format or "png").lower() if isinstance(format, str) else "png"
                def _repr_html_(self):
                    if self.url:
                        return f'<img src="{self.url}" alt="Image" />'
                    if self.data is not None:
                        encoded = _assistant__normalize(self.data)
                        if isinstance(encoded, str):
                            return f'<img src="data:image/{self.format};base64,{encoded}" alt="Image" />'
                    return "<img />"
                def _repr_png_(self):
                    if isinstance(self.data, (bytes, bytearray)):
                        return self.data
                    if isinstance(self.data, str):
                        try:
                            return base64.b64decode(self.data)
                        except Exception:
                            return None
                    return None

            display_mod.HTML = HTML
            display_mod.Markdown = Markdown
            display_mod.Image = Image
            display_mod.__assistant_patch__ = True
            sys.modules["IPython.display"] = display_mod
            ipy.display = display_mod

        if not hasattr(ipy, "get_ipython"):
            def _assistant__get_ipython():
                return None
            ipy.get_ipython = _assistant__get_ipython

    _assistant__ensure_ipython_display()
    _assistant__ensure_display_stage_dir()
    globals()["_ASSISTANT_DISPLAY_READY"] = True
