# Чинит названия закладок PDF: сопоставляет каждую закладку с заголовком страницы без учёта пробелов.
import json, re, sys
from pypdf import PdfReader, PdfWriter
from pypdf.generic import NameObject, TextStringObject
pdf, heads = sys.argv[1], json.load(open(sys.argv[2]))
key = lambda s: re.sub(r"\s+", "", s)
want = {}
for h in heads:
    k = key(re.sub(r"^Вариация \d\. ", "", h))
    want.setdefault(k, h)
w = PdfWriter(clone_from=PdfReader(pdf))
fixed = 0
node = w._root_object["/Outlines"].get_object().get("/First")
stack = []
while node is not None or stack:
    if node is None:
        node = stack.pop(); continue
    o = node.get_object()
    t = str(o.get("/Title", ""))
    good = want.get(key(t))
    if good and good != t:
        o[NameObject("/Title")] = TextStringObject(good); fixed += 1
    nxt = o.get("/Next")
    if "/First" in o:
        if nxt is not None: stack.append(nxt)
        node = o["/First"]
    else:
        node = nxt
w.write(pdf)
print("закладок исправлено:", fixed)
