
filename = "crash.log"
try:
    with open(filename, "r", encoding="utf-16") as f: # PowerShell > redirects often use UTF-16
        print(f.read())
except UnicodeError:
    with open(filename, "r", encoding="utf-8") as f:
        print(f.read())
except Exception as e:
    print(f"Error reading file: {e}")
