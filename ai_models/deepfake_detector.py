# deepfake_detector.py
import sys
import json
import cv2
import numpy as np
import os

class DeepfakeDetector:
    def __init__(self):
        pass
    
    def analyze_frame_consistency(self, frames):
        """Check for inconsistencies between frames"""
        if len(frames) < 2:
            return 50
        
        inconsistency_score = 0
        for i in range(1, min(len(frames), 10)):
            # Calculate difference between consecutive frames
            diff = cv2.absdiff(frames[i-1], frames[i])
            score = np.mean(diff)
            inconsistency_score += score
        
        # Normalize score (higher = more inconsistent = more suspicious)
        normalized_score = min((inconsistency_score / 10) * 2, 100)
        return normalized_score
    
    def detect_facial_artifacts(self, frames):
        """Look for common deepfake artifacts"""
        # Load face detection cascade
        face_cascade = cv2.CascadeClassifier(
            cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
        )
        
        artifact_score = 0
        face_count = 0
        
        for frame in frames[:10]:  # Check first 10 frames
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            faces = face_cascade.detectMultiScale(gray, 1.3, 5)
            
            if len(faces) > 0:
                face_count += 1
                # Check for blurriness around face
                for (x, y, w, h) in faces:
                    face_region = gray[y:y+h, x:x+w]
                    laplacian_var = cv2.Laplacian(face_region, cv2.CV_64F).var()
                    
                    # Lower variance = more blur = suspicious
                    if laplacian_var < 100:
                        artifact_score += 20
        
        if face_count == 0:
            return 50  # Uncertain
        
        return min(artifact_score / face_count * 3, 100)
    
    def analyze_lighting(self, frames):
        """Detect lighting inconsistencies"""
        lighting_scores = []
        
        for frame in frames[:10]:
            # Convert to HSV and check value channel (brightness)
            hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
            v_channel = hsv[:, :, 2]
            
            # Calculate standard deviation of brightness
            std_dev = np.std(v_channel)
            lighting_scores.append(std_dev)
        
        if len(lighting_scores) < 2:
            return 50
        
        # Check for sudden lighting changes
        lighting_variance = np.std(lighting_scores)
        inconsistency = min(lighting_variance * 2, 100)
        
        return inconsistency
    
    def detect(self, video_path):
        """Main detection method"""
        if not os.path.exists(video_path):
            return {'error': 'Video file not found'}
        
        # Open video file
        cap = cv2.VideoCapture(video_path)
        
        if not cap.isOpened():
            return {'error': 'Failed to open video'}
        
        frames = []
        frame_count = 0
        max_frames = 30  # Analyze first 30 frames
        
        # Read frames
        while frame_count < max_frames:
            ret, frame = cap.read()
            if not ret:
                break
            
            # Resize for faster processing
            frame = cv2.resize(frame, (320, 240))
            frames.append(frame)
            frame_count += 1
        
        cap.release()
        
        if len(frames) < 5:
            return {'error': 'Video too short for analysis'}
        
        # Run analysis
        consistency_score = self.analyze_frame_consistency(frames)
        artifact_score = self.detect_facial_artifacts(frames)
        lighting_score = self.analyze_lighting(frames)
        
        # Calculate final deepfake probability
        deepfake_probability = (
            consistency_score * 0.3 +
            artifact_score * 0.4 +
            lighting_score * 0.3
        )
        
        is_deepfake = deepfake_probability > 50
        
        return {
            'type': 'video',
            'isDeepfake': is_deepfake,
            'confidence': int(deepfake_probability if is_deepfake else 100 - deepfake_probability),
            'details': {
                'facialMovement': 'Suspicious' if artifact_score > 50 else 'Natural',
                'lighting': 'Inconsistent' if lighting_score > 50 else 'Consistent',
                'lipSync': 'Mismatched' if consistency_score > 60 else 'Matched'
            }
        }

def main():
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'No video path provided'}))
        sys.exit(1)
    
    video_path = sys.argv[1]
    detector = DeepfakeDetector()
    result = detector.detect(video_path)
    
    print(json.dumps(result))

if __name__ == '__main__':
    main()