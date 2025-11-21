import traceback
import sys

try:
    from d4rk.Logs import setup_logger
    print("Import successful")
except Exception:
    traceback.print_exc(file=sys.stdout)
