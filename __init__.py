"""hermes-translate — Python half (gateway-side translation backend).

The translation API lives in dashboard/plugin_api.py and mounts at
/api/plugins/hermes-translate/. This module intentionally registers no
agent tools: the plugin exists to serve its own desktop half.
"""


def register(ctx):
    """No agent-facing tools — the dashboard backend is the whole surface."""
    return None
