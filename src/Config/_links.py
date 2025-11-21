# src/Config/_links.py
import os

CHANNEL_LINK = 'https://t.me/pc_games_4_u'
START_IMGS = ['assets/IMGS/START/1.jpg']
LOGO = 'https://i.ibb.co/LhZtvnVz/6217502998695889825-99.jpg'
SEARCH_IMGS = [
    os.path.join("assets/IMGS/SEARCH", f)
    for f in os.listdir("assets/IMGS/SEARCH")
    if f.lower().endswith((".jpg", ".jpeg", ".png", ".gif", ".webp"))
]

START_IMGS = [
    os.path.join("assets/IMGS/START", f)
    for f in os.listdir("assets/IMGS/START")
    if f.lower().endswith((".jpg", ".jpeg", ".png", ".gif", ".webp"))
]