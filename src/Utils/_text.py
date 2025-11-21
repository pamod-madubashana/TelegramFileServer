import re

def smart_title(text: str) -> str:
    """
    Converts text into title case but preserves Roman numerals.
    Example: "the godfather part ii" -> "The Godfather Part II"
    """
    # List of valid Roman numerals (up to 3999, but shortened here)
    roman_pattern = r"\b(M{0,3}(CM|CD|D?C{0,3})" \
                    r"(XC|XL|L?X{0,3})(IX|IV|V?I{0,3}))\b"
    
    words = text.split()
    titled_words = []
    
    for word in words:
        if re.fullmatch(roman_pattern, word.upper()):
            titled_words.append(word.upper())  # keep Roman numerals uppercase
        else:
            titled_words.append(word.capitalize())
    
    return " ".join(titled_words)
