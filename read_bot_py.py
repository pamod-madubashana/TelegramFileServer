
file_path = r"D:\User\Documents\Repositories\Telegram\fileServer\.venv\Lib\site-packages\d4rk\Handlers\_bot.py"
try:
    with open(file_path, "r", encoding="utf-8") as f:
        lines = f.readlines()
        for i, line in enumerate(lines):
            print(f"{i+1}: {line.strip()}")
except Exception as e:
    print(f"Error: {e}")
