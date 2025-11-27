import { useEffect, useRef } from "react";
import "plyr/dist/plyr.css";

// Dynamically import Plyr to avoid TypeScript issues
let Plyr: any;

interface MediaPlayerProps {
  mediaUrl: string;
  fileName: string;
  fileType: "video" | "audio" | "voice";
  onClose: () => void;
}

export const MediaPlayer = ({ mediaUrl, fileName, fileType, onClose }: MediaPlayerProps) => {
  const playerRef = useRef<HTMLDivElement>(null);
  const plyrInstance = useRef<any>(null);

  useEffect(() => {
    // Dynamically import Plyr
    import("plyr").then((module) => {
      Plyr = module;
      
      if (playerRef.current) {
        // Clean up any existing player
        if (plyrInstance.current) {
          plyrInstance.current.destroy();
        }

        // Create player element based on file type
        const playerElement = document.createElement(
          fileType === "video" ? "video" : "audio"
        ) as HTMLVideoElement | HTMLAudioElement;
        playerElement.controls = true;
        playerElement.className = "w-full h-full";

        // Add source
        const source = document.createElement("source");
        source.src = mediaUrl;
        
        // Set type based on file extension
        const extension = fileName.split(".").pop()?.toLowerCase() || "";
        if (fileType === "video") {
          switch (extension) {
            case "mp4":
              source.type = "video/mp4";
              break;
            case "webm":
              source.type = "video/webm";
              break;
            case "ogg":
              source.type = "video/ogg";
              break;
            default:
              source.type = "video/mp4";
          }
        } else {
          switch (extension) {
            case "mp3":
              source.type = "audio/mpeg";
              break;
            case "wav":
              source.type = "audio/wav";
              break;
            case "ogg":
              source.type = "audio/ogg";
              break;
            default:
              source.type = "audio/mpeg";
          }
        }
        
        playerElement.appendChild(source);
        playerRef.current.appendChild(playerElement);

        // Initialize Plyr
        plyrInstance.current = new Plyr(playerElement, {
          controls: [
            "play-large",
            "play",
            "progress",
            "current-time",
            "duration",
            "mute",
            "volume",
            "captions",
            "settings",
            "pip",
            "airplay",
            "download",
            "fullscreen",
          ],
          settings: ["captions", "quality", "speed", "loop"],
          ratio: "16:9",
          quality: {
            default: 576,
            options: [4320, 2880, 2160, 1440, 1080, 720, 576, 480, 360, 240],
          },
          i18n: {
            restart: "Restart",
            rewind: "Rewind {seektime}s",
            play: "Play",
            pause: "Pause",
            fastForward: "Forward {seektime}s",
            seek: "Seek",
            seekLabel: "{currentTime} of {duration}",
            played: "Played",
            buffered: "Buffered",
            currentTime: "Current time",
            duration: "Duration",
            volume: "Volume",
            mute: "Mute",
            unmute: "Unmute",
            enableCaptions: "Enable captions",
            disableCaptions: "Disable captions",
            download: "Download",
            enterFullscreen: "Enter fullscreen",
            exitFullscreen: "Exit fullscreen",
            frameTitle: "Player for {title}",
            captions: "Captions",
            settings: "Settings",
            pip: "PIP",
            menuBack: "Go back to previous menu",
            speed: "Speed",
            normal: "Normal",
            quality: "Quality",
            loop: "Loop",
          },
        });

        // Add event listeners
        plyrInstance.current.on("ended", () => {
          console.log("Media ended");
        });

        plyrInstance.current.on("error", (error: any) => {
          console.error("Plyr error:", error);
        });
      }
    });

    // Cleanup function
    return () => {
      if (plyrInstance.current) {
        plyrInstance.current.destroy();
        plyrInstance.current = null;
      }
    };
  }, [mediaUrl, fileName, fileType]);

  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-90 z-50 flex flex-col">
      <div className="absolute top-4 right-4 z-10">
        <button
          onClick={handleClose}
          className="text-white hover:text-gray-300 transition-colors bg-black bg-opacity-50 rounded-full p-2"
          aria-label="Close player"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-6 w-6"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </div>
      
      <div className="absolute top-4 left-4 text-white text-lg font-semibold z-10">
        {fileName}
      </div>
      
      <div 
        ref={playerRef}
        className={`flex-1 flex items-center justify-center ${fileType === "video" ? "w-full h-full" : "w-full max-w-3xl mx-auto"}`}
      />
    </div>
  );
};