"""Funções puras de normalização de resultado (sem rede)."""
from backend import importers


def test_chesscom_result():
    assert importers._chesscom_result({"white": {"result": "win"}, "black": {"result": "resigned"}}) == "1-0"
    assert importers._chesscom_result({"white": {"result": "checkmated"}, "black": {"result": "win"}}) == "0-1"
    assert importers._chesscom_result({"white": {"result": "agreed"}, "black": {"result": "agreed"}}) == "1/2-1/2"


def test_lichess_result():
    assert importers._lichess_result({"winner": "white"}) == "1-0"
    assert importers._lichess_result({"winner": "black"}) == "0-1"
    assert importers._lichess_result({}) == "1/2-1/2"
