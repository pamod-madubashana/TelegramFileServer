
filename = "crash.log"
try:
    with open(filename, "r", encoding="utf-8") as f:
        print(f.read(1000))
except Exception as e:
    print(f"Error reading file: {e}")
