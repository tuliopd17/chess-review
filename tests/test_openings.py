"""Detecção de abertura por posição (EPD), offline dos TSVs commitados."""
from backend import openings


def test_caro_kann_detectada():
    # 1.e4 c6 -> Caro-Kann.
    res = openings.detect_opening_for_game(["e2e4", "c7c6"])
    assert res["name"] and "Caro-Kann" in res["name"]
    assert res["eco"] and res["eco"].startswith("B")
    assert res["last_book_ply"] >= 2


def test_transposicao_reconhecida_por_posicao():
    # Mesma posição por ordens diferentes deve casar (indexado por EPD).
    # 1.Nf3 d5 2.d4 e 1.d4 d5 2.Nf3 chegam ao mesmo lugar.
    a = openings.detect_opening_for_game(["g1f3", "d7d5", "d2d4"])
    b = openings.detect_opening_for_game(["d2d4", "d7d5", "g1f3"])
    assert a["name"] == b["name"]
    assert a["name"] is not None


def test_in_book_e_contiguo_ate_last_book_ply():
    res = openings.detect_opening_for_game(["e2e4", "e7e5", "g1f3", "b8c6"])
    lbp = res["last_book_ply"]
    assert res["in_book"] == [i < lbp for i in range(4)]


def test_partida_vazia_nao_quebra():
    res = openings.detect_opening_for_game([])
    assert res["in_book"] == []
    assert res["last_book_ply"] == 0
