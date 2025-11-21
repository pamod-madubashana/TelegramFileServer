
filename = "crash.log"
try:
    with open(filename, "r", encoding="utf-8") as f:
        content = f.read()
        print(content.replace("\n", " || "))
except Exception as e:
    print(f"Error reading file: {e}")
