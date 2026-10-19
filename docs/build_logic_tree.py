import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch
from matplotlib import font_manager as fm

fm.fontManager.addfont("/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf")
plt.rcParams["font.family"] = "IPAGothic"

W, H = 26, 17
fig, ax = plt.subplots(figsize=(W, H), dpi=100)
ax.set_xlim(0, W); ax.set_ylim(0, H); ax.axis("off")

COL = {"root": "#1f3a5f", "A": "#2e6da4", "B": "#2e8b57", "C": "#c27c0e", "R": "#8a3b3b"}
def box(x, y, w, h, text, color, fc="white", tc=None, fs=11, bold=False):
    ax.add_patch(FancyBboxPatch((x, y - h/2), w, h, boxstyle="round,pad=0.02,rounding_size=0.12",
                                fc=fc, ec=color, lw=2))
    ax.text(x + w/2, y, text, ha="center", va="center", fontsize=fs, color=tc or color,
            fontweight="bold" if bold else "normal", linespacing=1.45)
def line(x1, y1, x2, y2, color):
    xm = (x1 + x2) / 2
    ax.plot([x1, xm, xm, x2], [y1, y1, y2, y2], color=color, lw=1.6, zorder=0)

ax.text(W/2, H-0.5, "算命学の宿命の自覚が子供の進路に与える影響 ― 研究ロジックツリー",
        ha="center", fontsize=20, color=COL["root"], fontweight="bold")

# columns
x0, x1, x2, x3 = 0.3, 4.6, 9.0, 14.6
w0, w1, w2, w3 = 3.6, 3.7, 4.9, 11.0
ax.text(x0+w0/2, H-1.4, "研究の問い", ha="center", fontsize=12, color="gray")
ax.text(x1+w1/2, H-1.4, "目的", ha="center", fontsize=12, color="gray")
ax.text(x2+w2/2, H-1.4, "研究設問(RQ)・仮説", ha="center", fontsize=12, color="gray")
ax.text(x3+w3/2, H-1.4, "測定指標(T0鑑定前 / T1直後 / T2 3ヶ月後)", ha="center", fontsize=12, color="gray")

# root
ry = 8.3
box(x0, ry, w0, 3.2, "算命学の宿命を\n子供本人が知ることは\n進路・将来・親子関係に\nどう影響するのか", COL["root"],
    fc=COL["root"], tc="white", fs=13, bold=True)

# level 1
ay, by, cy = 11.9, 4.9, 1.7
box(x1, ay, w1, 1.7, "目的A【学術】\n教育への影響を観測", COL["A"], fc=COL["A"], tc="white", fs=12, bold=True)
box(x1, by, w1, 1.7, "目的B【事業】\n新しい活用法の探索", COL["B"], fc=COL["B"], tc="white", fs=12, bold=True)
box(x1, cy, w1, 1.7, "目的C【広報】\n参加者の声を収集", COL["C"], fc=COL["C"], tc="white", fs=12, bold=True)
for y, c in ((ay, "A"), (by, "B"), (cy, "C")):
    line(x0+w0, ry, x1, y, COL[c])

# level 2 + 3
A = [("RQ1 自己理解は変わるか\nH1:直後に上昇し3ヶ月後も維持", "自己理解10項目 / 自己肯定感4項目 / 将来展望3項目(5件法)"),
     ("RQ2 進路への自信と行動は変わるか\nH3:短期上昇→3ヶ月後に縮小", "進路自己効力感8項目 / 志望の確信度 / 調べた・体験・相談の回数"),
     ("RQ3 親子の対話・保護者の理解は\n変わるか  H2:対話が増える", "会話頻度(子・親) / 子供理解P3〜P8 / 関わり方P9〜P12"),
     ("RQ4 誰に効果が出やすいか", "学年・性別・事前の確信度・鑑定師ID・保護者関与度(層別・調整)"),
     ("RQ5 ネガティブな影響はないか\nH4:決定論的受け止めがリスク", "決定論的受け止め(B5/C7) / 選択肢の狭まり(C8) / 不安(B4) / 当たっている感(B1)")]
ys = [14.2, 12.7, 11.2, 9.7, 8.2]
for (rq, ind), y in zip(A, ys):
    box(x2, y, w2, 1.2, rq, COL["A"], fs=10)
    box(x3, y, w3, 1.2, ind, COL["R"], fs=10)
    line(x1+w1, ay, x2, y, COL["A"])
    ax.plot([x2+w2, x3], [y, y], color=COL["A"], lw=1.6, zorder=0)

Bs = [("RQ6 どの要素が有用か", "説明の仕方 / 資料 / 面談時間 / 事後フォロー の要素別 有用度ランキング"),
      ("参加者の評価", "満足度 / 有用度 / 推奨度(NPS) / 価格感 / 改善要望(T1・T2)"),
      ("提供モデルの型づくり", "標準シナリオ・鑑定師記録票・T2面談の自由記述(テーマ分析)")]
for (rq, ind), y in zip(Bs, [6.4, 4.9, 3.4]):
    box(x2, y, w2, 1.0, rq, COL["B"], fs=10)
    box(x3, y, w3, 1.0, ind, COL["R"], fs=10)
    line(x1+w1, by, x2, y, COL["B"])
    ax.plot([x2+w2, x3], [y, y], color=COL["B"], lw=1.6, zorder=0)

Cs = [("体験談・感想(研究とは分離)", "T2終了後に別フォームで任意回収 / 掲載範囲・媒体ごとに同意 / 誘導質問は禁止"),
      ("広告表現のルール", "効果を保証する表現を避ける / 表示ルールの確認【要確認】")]
for (rq, ind), y in zip(Cs, [2.2, 0.9]):
    box(x2, y, w2, 1.0, rq, COL["C"], fs=10)
    box(x3, y, w3, 1.0, ind, COL["R"], fs=10)
    line(x1+w1, cy, x2, y, COL["C"])
    ax.plot([x2+w2, x3], [y, y], color=COL["C"], lw=1.6, zorder=0)

ax.text(W-0.3, 0.2, "※ 因果の確認には待機群(案B)が必要 / 研究回答と広告用の声は別同意・別フォーム",
        ha="right", fontsize=10, color="gray")
fig.savefig("/home/user/kante-report/docs/logic_tree.png", bbox_inches="tight", facecolor="white")
