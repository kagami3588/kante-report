import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch
from matplotlib import font_manager as fm
fm.fontManager.addfont("/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf")
plt.rcParams["font.family"] = "IPAGothic"

def rbox(ax, x, y, w, h, text, fc, tc="white", fs=13, ec=None, lw=1.5):
    ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.02,rounding_size=0.15",
                                fc=fc, ec=ec or fc, lw=lw))
    ax.text(x + w/2, y + h/2, text, ha="center", va="center", fontsize=fs, color=tc, linespacing=1.5)

def arrow(ax, x1, y1, x2, y2, color="#555"):
    ax.add_patch(FancyArrowPatch((x1, y1), (x2, y2), arrowstyle="-|>", mutation_scale=22, color=color, lw=2.2))

# ---------- 参加者の流れ ----------
fig, ax = plt.subplots(figsize=(13, 5.6), dpi=110)
ax.set_xlim(0, 13); ax.set_ylim(0, 5.6); ax.axis("off")
ax.text(6.5, 5.25, "参加される方の流れ(ご家庭 = お子さん + 保護者1名)", ha="center", fontsize=17, color="#1f3a5f", fontweight="bold")
steps = [
    ("1  申込・同意", "#1f3a5f", "保護者・お子さん", "説明を読み同意し\n鑑定費をお振込み", "約20分"),
    ("2  鑑定前の\n質問", "#2e6da4", "お子さん・保護者\n(別々に回答)", "鑑定の1週間前\n〜前日まで", "各10分"),
    ("3  鑑定\nセッション", "#2e8b57", "鑑定:林 竜輔\n親子で参加", "宿命を伝え、保護者に\n接し方をご提案", "60分"),
    ("4  直後\nアンケート", "#2e6da4", "お子さん・保護者\n(別々に回答)", "鑑定の当日\n〜3日以内", "各10分"),
    ("5  3か月後の\nセッション", "#c27c0e", "セッション:林 竜輔\nお子さん・保護者", "鑑定から約3か月後\n+アンケート", "セッション60分\n+アンケ各10分"),
    ("6  (任意)\n半年〜1年後", "#8a3b3b", "保護者", "進路の結果を\n教えてください", "5分"),
]
n = len(steps); bw = 1.8; gap = (13 - 0.4 - n*bw) / (n-1)
for i, (t, c, who, what, time) in enumerate(steps):
    x = 0.2 + i*(bw+gap)
    rbox(ax, x, 3.1, bw, 1.6, t, c, fs=13)
    ax.text(x+bw/2, 2.7, who, ha="center", va="top", fontsize=10.5, color="#222", linespacing=1.4)
    ax.text(x+bw/2, 1.75, what, ha="center", va="top", fontsize=10.5, color="#444", linespacing=1.4)
    rbox(ax, x+0.15, 0.55, bw-0.3, 0.55, time, "#f2f2f2", tc="#222", fs=11, ec="#999", lw=1)
    if i < n-1:
        arrow(ax, x+bw+0.04, 3.9, x+bw+gap-0.04, 3.9)
ax.text(6.5, 0.12, "※ 不安になったときは24時間以内に運営(KAGAMI)から連絡します。いつでも参加をやめられます。", ha="center", fontsize=11, color="#8a3b3b")
fig.savefig("flow_participant.png", bbox_inches="tight", facecolor="white")
plt.close(fig)

# ---------- ロジックツリー(簡略) ----------
fig, ax = plt.subplots(figsize=(13, 8), dpi=110)
ax.set_xlim(0, 13); ax.set_ylim(0, 8); ax.axis("off")
ax.text(6.5, 7.6, "この研究の考え方(ロジックツリー)", ha="center", fontsize=18, color="#1f3a5f", fontweight="bold")
for x, t in ((0.2, "知りたいこと"), (3.4, "目的"), (6.9, "調べること"), (10.1, "測る項目")):
    ax.text(x+1.4, 7.05, t, ha="center", fontsize=12, color="gray")
rbox(ax, 0.2, 2.7, 2.8, 2.2, "算命学の宿命を\nお子さん本人が知ると\n進路や親子関係に\nどう影響するか", "#1f3a5f", fs=13)
rows = [
    (4.6, "#2e6da4", "目的A\n学術:教育への影響を\n調べる",
     "・自己理解は深まるか\n・進路への自信と行動は\n  変わるか\n・親子の会話や親の理解は\n  変わるか\n・マイナスの影響はないか",
     "自己理解/自己肯定感\n進路への自信/将来展望\n進路のための行動\n親子の会話・親の理解\n「どうせ決まっている」\nと思う気持ち"),
    (2.65, "#2e8b57", "目的B\n事業:新しい活用法を\n探る",
     "・どんな説明が役立つか\n・どんな家庭に合うか",
     "満足度・おすすめ度\n役立った場面\n鑑定師の記録"),
    (0.95, "#c27c0e", "目的C\n広報:参加者の声を\n集める",
     "・体験の感想\n  (研究とは別に集める)",
     "感想の自由記述\n掲載してよい範囲\n(別の同意)"),
]
for y, c, t, what, meas in rows:
    h = {"#2e6da4": 2.0, "#2e8b57": 1.5, "#c27c0e": 1.3}[c]
    yy = y
    rbox(ax, 3.4, yy, 3.0, h, t, c, fs=11.5)
    rbox(ax, 6.9, yy, 3.0, h, what, "white", tc="#222", fs=10, ec=c, lw=2)
    rbox(ax, 10.1, yy, 2.7, h, meas, "white", tc="#8a3b3b", fs=10, ec="#8a3b3b", lw=2)
    arrow(ax, 3.0, 3.8, 3.38, yy+h/2, color=c)
    arrow(ax, 6.42, yy+h/2, 6.88, yy+h/2, color=c)
    arrow(ax, 9.92, yy+h/2, 10.08, yy+h/2, color=c)
ax.text(6.5, 0.3, "※ 研究のアンケートと、広告に使う声の収集は別々に行い、同意も別々に取ります。", ha="center", fontsize=11, color="gray")
fig.savefig("logic_tree_simple.png", bbox_inches="tight", facecolor="white")
