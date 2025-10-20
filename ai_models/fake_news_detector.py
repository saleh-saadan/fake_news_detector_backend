# fake_news_detector.py
import sys
import json
import re
from collections import Counter

# Simple NLP-based fake news detection
class FakeNewsDetector:
    def __init__(self):
        # Keywords that often appear in fake news
        self.fake_indicators = [
            'shocking', 'unbelievable', 'breaking', 'must see', 'you won\'t believe',
            'doctors hate', 'secret', 'they don\'t want you to know', 'miracle',
            'amazing', 'revealed', 'exposed', 'truth', 'hoax', 'conspiracy'
        ]
        
        # Trusted source indicators
        self.trusted_sources = [
            'bbc', 'reuters', 'ap news', 'associated press', 'npr', 'pbs',
            'wall street journal', 'new york times', 'washi1ngton post', 'the guardian'
        ]
    
    def analyze_emotional_language(self, text):
        """Check for excessive emotional language"""
        text_lower = text.lower()
        count = sum(1 for word in self.fake_indicators if word in text_lower)
        
        # Count exclamation marks and ALL CAPS words
        exclamation_count = text.count('!')
        caps_words = len(re.findall(r'\b[A-Z]{3,}\b', text))
        
        score = (count * 2 + exclamation_count + caps_words) / (len(text.split()) / 10)
        return min(score * 10, 100)  # Scale to percentage
    
    def check_source_trust(self, text):
        """Check if text mentions trusted sources"""
        text_lower = text.lower()
        trusted_count = sum(1 for source in self.trusted_sources if source in text_lower)
        return 100 if trusted_count > 0 else 30
    
    def analyze_claim_verification(self, text):
        """Simple heuristic for claim verification"""
        # Look for citations, quotes, specific dates, numbers
        has_quotes = '"' in text or '"' in text
        has_numbers = bool(re.search(r'\d+', text))
        has_dates = bool(re.search(r'\b\d{4}\b|\b(January|February|March|April|May|June|July|August|September|October|November|December)\b', text))
        
        score = (has_quotes * 30 + has_numbers * 20 + has_dates * 20 + 30)
        return min(score, 100)
    
    def detect(self, text):
        """Main detection method"""
        emotional_score = self.analyze_emotional_language(text)
        trust_score = self.check_source_trust(text)
        verification_score = self.analyze_claim_verification(text)
        
        # Calculate final fake probability
        fake_probability = (
            emotional_score * 0.4 +
            (100 - trust_score) * 0.4 +
            (100 - verification_score) * 0.2
        )
        
        is_fake = fake_probability > 50
        
        return {
            'type': 'news',
            'isFake': is_fake,
            'confidence': int(fake_probability if is_fake else 100 - fake_probability),
            'details': {
                'emotionalLanguage': 'High' if emotional_score > 50 else 'Low',
                'sourceTrust': 'Trusted' if trust_score > 60 else 'Questionable',
                'claimVerification': 'Verified' if verification_score > 60 else 'Unverified'
            }
        }

def main():
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'No text provided'}))
        sys.exit(1)
    
    text = sys.argv[1]
    detector = FakeNewsDetector()
    result = detector.detect(text)
    
    print(json.dumps(result))

if __name__ == '__main__':
    main()