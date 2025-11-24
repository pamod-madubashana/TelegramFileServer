# src/Config/_strings.py

START_MSG = """
<b>Hello {user_mention} !!!</b>

🎬 <b>Welcome to Telegram File Server!</b>
Your personal movie vault, right here on Telegram.

🍿 Browse. Search. Streamline.
📽️ From classics to the latest drops, everything is just a tap away.
✨ Fast, clean, and built for real movie lovers.
"""

WELCOME_MSG = """
👋 Hey {user_mention},

Welcome to {chat_title} group chat !
"""

GOODBYE_MSG = """
👋 Hey {user_mention},

Goodbye from {chat_title} group chat !
"""

SEARCH_MOVIE_MESSAGE =  """
🤭 <i><b>Hi {user_mention}</b></i>

<i><b>⭕️ Let's see if your search on "{user_text_link}" is on the list below</b></i>
"""
MOVIE_NOT_FOUND = """

<b><i>🤒 Sorry {user_mention}, 

If "{user_text_link}" was not here, it means it is not in my database.

Check these first ‼️

🔴 Please check if you have entered the name correctly.
🔴 Try adding the released year after the movie name. Example : "The Avengers 2012".

🟢 You can also help us to improve our database by requesting the movie you weren't able to find here.

🤠 Press the button below to request the movie, Admins will take care of it as soon as possible.</i></b>"""

SELECT_QUALITY = """
<i><b>{title}</b></i>

⭕️ <i><b>From the list of Qualities below, which one are you looking for ?</b></i> 🧐"""

SELECT_FILES = """
<i><b>{title} {quality}</b></i>

⭕️ <i><b>From the list of Files below, which one are you looking for ?</b></i> 🧐"""

DOWNLOAD_MSG = """ 
🔰 <b><i>{title}</i></b> 🔰
─────────────────────
<blockquote>● <b>Released :</b> <i>{year}</i>
● <b>genres :</b> <i>{genres}</i>
● <b>IMDB :</b> <i>{rating}/10</i></blockquote>
─────────────────────

🔴<i><b>{file}</b></i>"""

INFO_MSG = """

🔴 <i>If you are downloading a x265 codec file, you must make sure that your device supports x265 codec before you download it <b>ESPECIALLY MOBILE PHONES</b>

⭕️ From this link you can learn more about <a href='https://youtu.be/SUvlWYD67QQ?si=r39taBNrH8ItPKkq'>x265 vs 264</a>

🟢 All the 4K Movies are compressed to reduce the size and those files will be shown as ZIP files, In order watch the movie you will have to excract the ZIP file.

🟢 Here are few Media Players that commonly used to watch movies from each OS

🔰Android : <b><a href='https://play.google.com/store/apps/details?id=org.videolan.vlc'>VLC</a> | <a href='https://play.google.com/store/apps/details?id=com.mxtech.videoplayer.ad'>MX Player</a> | <a href='https://play.google.com/store/apps/details?id=com.kmplayer'>KMPlayer</a></b>
🔰Ios : <b><a href='https://apps.apple.com/us/app/nplayer/id1116905928'>nPlayer</a> | <a href='https://apps.apple.com/us/app/infuse-6/id1136220934'>Infuse</a></b>
🔰Windows : <b><a href='https://www.videolan.org/index.html'>VLC</a> | <a href='https://www.kmplayer.com/home'>KMPlayer</a> | <a href='https://potplayer.daum.net/'>Pot Player</a></b>

<span class="tg-spoiler">For 4K Movies, I suggest you use VLC media player. (from my personal experience.)</span>

Come Again {user_mention} !!!</i>
"""

