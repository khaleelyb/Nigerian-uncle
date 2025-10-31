
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { GoogleGenAI, LiveSession, Modality, LiveServerMessage } from '@google/genai';
import { CallState, TranscriptionTurn } from './types';
import { createBlob, decode, decodeAudioData } from './utils/audio';
import { PhoneIcon, HangUpIcon, MicIcon } from './components/Icons';

const App: React.FC = () => {
    const [callState, setCallState] = useState<CallState>('idle');
    const [transcriptionHistory, setTranscriptionHistory] = useState<TranscriptionTurn[]>([]);
    const [callDuration, setCallDuration] = useState(0);

    const sessionPromiseRef = useRef<Promise<LiveSession> | null>(null);
    const audioContextRef = useRef<AudioContext | null>(null);
    const outputAudioContextRef = useRef<AudioContext | null>(null);
    const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
    const mediaStreamSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
    const mediaStreamRef = useRef<MediaStream | null>(null);
    
    const currentInputTranscriptionRef = useRef('');
    const currentOutputTranscriptionRef = useRef('');
    const nextStartTimeRef = useRef(0);
    const audioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
    // Fix: Replace NodeJS.Timeout with ReturnType<typeof setInterval> for browser environments.
    const callTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const formatTime = (seconds: number) => {
        const mins = Math.floor(seconds / 60).toString().padStart(2, '0');
        const secs = (seconds % 60).toString().padStart(2, '0');
        return `${mins}:${secs}`;
    };

    const startCallTimer = () => {
        if (callTimerRef.current) clearInterval(callTimerRef.current);
        setCallDuration(0);
        callTimerRef.current = setInterval(() => {
            setCallDuration(prev => prev + 1);
        }, 1000);
    };

    const stopCallTimer = () => {
        if (callTimerRef.current) {
            clearInterval(callTimerRef.current);
            callTimerRef.current = null;
        }
    };

    const cleanup = useCallback(() => {
        console.log("Cleaning up resources...");
        stopCallTimer();

        if (sessionPromiseRef.current) {
            sessionPromiseRef.current.then(session => session.close()).catch(console.error);
            sessionPromiseRef.current = null;
        }

        if (scriptProcessorRef.current) {
            scriptProcessorRef.current.disconnect();
            scriptProcessorRef.current.onaudioprocess = null;
            scriptProcessorRef.current = null;
        }

        if (mediaStreamSourceRef.current) {
            mediaStreamSourceRef.current.disconnect();
            mediaStreamSourceRef.current = null;
        }

        if (mediaStreamRef.current) {
            mediaStreamRef.current.getTracks().forEach(track => track.stop());
            mediaStreamRef.current = null;
        }

        if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
            audioContextRef.current.close().catch(console.error);
            audioContextRef.current = null;
        }
        
        if (outputAudioContextRef.current && outputAudioContextRef.current.state !== 'closed') {
            outputAudioContextRef.current.close().catch(console.error);
            outputAudioContextRef.current = null;
        }
        
        audioSourcesRef.current.forEach(source => source.stop());
        audioSourcesRef.current.clear();
        nextStartTimeRef.current = 0;
    }, []);

    const handleAnswerCall = async () => {
        setCallState('active');
        startCallTimer();
        setTranscriptionHistory([]);
        currentInputTranscriptionRef.current = '';
        currentOutputTranscriptionRef.current = '';

        try {
            const ai = new GoogleGenAI({ apiKey: process.env.API_KEY as string });
            
            audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
            outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
            
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaStreamRef.current = stream;

            sessionPromiseRef.current = ai.live.connect({
                model: 'gemini-2.5-flash-native-audio-preview-09-2025',
                config: {
                    responseModalities: [Modality.AUDIO],
                    speechConfig: {
                        voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
                    },
                    systemInstruction: "You are a very funny Nigerian man named Uncle Tunde with a thick Nigerian accent. Start the conversation by saying something like 'Ahh ahh, my friend, you are welcome! Are you alright? What is the matter?'. Your goal is to be warm, funny, and tell jokes or funny stories. Use Nigerian Pidgin English phrases like 'How far?', 'No wahala', 'Oya', 'E go be'. Keep your responses conversational and relatively short, as if you are on a phone call.",
                    inputAudioTranscription: {},
                    outputAudioTranscription: {},
                },
                callbacks: {
                    onopen: () => {
                        console.log('Session opened.');
                        if (!audioContextRef.current || !mediaStreamRef.current) return;
                        
                        mediaStreamSourceRef.current = audioContextRef.current.createMediaStreamSource(mediaStreamRef.current);
                        scriptProcessorRef.current = audioContextRef.current.createScriptProcessor(4096, 1, 1);
                        
                        scriptProcessorRef.current.onaudioprocess = (audioProcessingEvent) => {
                            const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);
                            const pcmBlob = createBlob(inputData);
                            if (sessionPromiseRef.current) {
                                sessionPromiseRef.current.then((session) => {
                                    session.sendRealtimeInput({ media: pcmBlob });
                                });
                            }
                        };

                        mediaStreamSourceRef.current.connect(scriptProcessorRef.current);
                        scriptProcessorRef.current.connect(audioContextRef.current.destination);
                    },
                    onmessage: async (message: LiveServerMessage) => {
                        if (message.serverContent?.inputTranscription) {
                            currentInputTranscriptionRef.current += message.serverContent.inputTranscription.text;
                        }
                        if (message.serverContent?.outputTranscription) {
                            currentOutputTranscriptionRef.current += message.serverContent.outputTranscription.text;
                        }

                        if (message.serverContent?.turnComplete) {
                            const userInput = currentInputTranscriptionRef.current.trim();
                            const aiResponse = currentOutputTranscriptionRef.current.trim();
                            
                            setTranscriptionHistory(prev => {
                                const newHistory = [...prev];
                                if (userInput) newHistory.push({ speaker: 'user', text: userInput });
                                if (aiResponse) newHistory.push({ speaker: 'ai', text: aiResponse });
                                return newHistory;
                            });

                            currentInputTranscriptionRef.current = '';
                            currentOutputTranscriptionRef.current = '';
                        }
                        
                        const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
                        if (base64Audio && outputAudioContextRef.current) {
                            nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputAudioContextRef.current.currentTime);
                            const audioBuffer = await decodeAudioData(decode(base64Audio), outputAudioContextRef.current, 24000, 1);
                            const source = outputAudioContextRef.current.createBufferSource();
                            source.buffer = audioBuffer;
                            source.connect(outputAudioContextRef.current.destination);
                            
                            source.addEventListener('ended', () => {
                                audioSourcesRef.current.delete(source);
                            });

                            source.start(nextStartTimeRef.current);
                            nextStartTimeRef.current += audioBuffer.duration;
                            audioSourcesRef.current.add(source);
                        }
                    },
                    onerror: (e: ErrorEvent) => {
                        console.error('Session error:', e);
                        setCallState('ended');
                    },
                    onclose: () => {
                        console.log('Session closed.');
                        cleanup();
                    },
                }
            });

        } catch (error) {
            console.error("Failed to start call:", error);
            alert("Could not start the call. Please ensure you have given microphone permissions.");
            setCallState('idle');
        }
    };
    
    const handleEndCall = () => {
        setCallState('ended');
    };

    useEffect(() => {
        if (callState === 'ended') {
            cleanup();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [callState]);

    const renderCallScreen = () => {
        switch (callState) {
            case 'ringing':
                return (
                    <div className="flex flex-col items-center justify-between h-full text-white p-8 animate-fadeIn">
                        <div className="text-center mt-12">
                            <div className="w-24 h-24 bg-gray-600 rounded-full mx-auto mb-4 flex items-center justify-center text-4xl font-bold">UT</div>
                            <p className="text-3xl font-semibold">Uncle Tunde</p>
                            <p className="text-gray-400">Nigeria</p>
                        </div>
                        <div className="flex justify-around w-full max-w-xs">
                            <button onClick={handleEndCall} className="flex flex-col items-center space-y-2 text-white">
                                <div className="w-16 h-16 bg-red-600 rounded-full flex items-center justify-center transform hover:scale-105 transition-transform">
                                    <HangUpIcon className="w-8 h-8"/>
                                </div>
                                <span className="text-sm">Decline</span>
                            </button>
                            <button onClick={handleAnswerCall} className="flex flex-col items-center space-y-2 text-white">
                                <div className="w-16 h-16 bg-green-600 rounded-full flex items-center justify-center transform hover:scale-105 transition-transform">
                                    <PhoneIcon className="w-8 h-8"/>
                                </div>
                                <span className="text-sm">Answer</span>
                            </button>
                        </div>
                    </div>
                );
            case 'active':
                 return (
                    <div className="flex flex-col h-full text-white p-4">
                        <div className="text-center pt-8 pb-4">
                            <p className="text-3xl font-semibold">Uncle Tunde</p>
                            <p className="text-green-400">{formatTime(callDuration)}</p>
                        </div>
                        <div className="flex-grow bg-black bg-opacity-20 rounded-lg p-4 overflow-y-auto mb-4 space-y-4">
                            {transcriptionHistory.map((turn, index) => (
                                <div key={index} className={`flex ${turn.speaker === 'user' ? 'justify-end' : 'justify-start'}`}>
                                    <div className={`max-w-xs md:max-w-md px-4 py-2 rounded-2xl ${turn.speaker === 'user' ? 'bg-blue-600 rounded-br-none' : 'bg-gray-700 rounded-bl-none'}`}>
                                        <p>{turn.text}</p>
                                    </div>
                                </div>
                            ))}
                            <div className="flex justify-center items-center h-full" hidden={transcriptionHistory.length > 0}>
                                <div className="text-center text-gray-400">
                                    <MicIcon className="w-16 h-16 mx-auto animate-pulse"/>
                                    <p className="mt-2">Start speaking...</p>
                                </div>
                            </div>
                        </div>
                        <div className="flex justify-center py-4">
                            <button onClick={handleEndCall} className="w-16 h-16 bg-red-600 rounded-full flex items-center justify-center transform hover:scale-105 transition-transform">
                                <HangUpIcon className="w-8 h-8"/>
                            </button>
                        </div>
                    </div>
                );
            case 'ended':
                return (
                    <div className="flex flex-col items-center justify-center h-full text-white p-8 animate-fadeIn">
                        <p className="text-2xl mb-2">Call Ended</p>
                        <p className="text-gray-400 mb-8">Duration: {formatTime(callDuration)}</p>
                        <button onClick={() => setCallState('ringing')} className="px-6 py-3 bg-blue-600 rounded-full hover:bg-blue-700 transition-colors">
                            Call Again
                        </button>
                    </div>
                );
            default: // idle
                return (
                    <div className="flex flex-col items-center justify-center h-full text-white p-8 animate-fadeIn">
                         <h1 className="text-4xl font-bold text-center mb-4">Nigerian Uncle Caller</h1>
                        <p className="text-gray-300 text-center mb-12">Experience a hilarious phone call with a virtual Nigerian Uncle powered by Gemini.</p>
                        <button onClick={() => setCallState('ringing')} className="flex items-center space-x-3 px-8 py-4 bg-green-600 rounded-full text-xl font-semibold hover:bg-green-700 transition-colors shadow-lg">
                            <PhoneIcon className="w-6 h-6"/>
                            <span>Call Uncle Tunde</span>
                        </button>
                    </div>
                );
        }
    };
    
    return (
        <main className="w-full min-h-screen bg-gray-900 flex items-center justify-center p-4">
            <div className="w-full max-w-sm h-[700px] bg-black rounded-[40px] border-8 border-gray-700 shadow-2xl overflow-hidden relative">
                {/* Phone wallpaper background */}
                <div className="absolute inset-0 bg-cover bg-center" style={{backgroundImage: "url('https://picsum.photos/400/800?blur=10')"}}></div>
                <div className="absolute inset-0 bg-black bg-opacity-60"></div>
                
                {/* Notch */}
                <div className="absolute top-0 left-1/2 -translate-x-1/2 w-32 h-6 bg-gray-700 rounded-b-xl"></div>
                
                <div className="relative z-10 w-full h-full pt-6">
                    {renderCallScreen()}
                </div>
            </div>
        </main>
    );
};

export default App;
