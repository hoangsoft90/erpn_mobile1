"""Localhost HTTP bridge around :func:`vietnamese_nlp.normalize`.

See ``nlp_service/server.py``. The bridge transport (HTTP on 127.0.0.1) is the
locked decision connecting the Python NLP pipeline to the Node/dsh side.
"""
