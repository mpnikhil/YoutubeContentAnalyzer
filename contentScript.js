// contentScript.js
class YouTubeAnalyzer {
  constructor() {
    this.baseUrl = 'http://localhost:11434';
    this.currentVideoId = null;
    this.retryCount = 0;
    this.MAX_RETRIES = 3;
    this.RETRY_DELAY = 1000;
  }

  async generateChapterSummaries(transcript, chapters) {
    const summaries = [];

    // Add end timestamp to chapters
    for (let i = 0; i < chapters.length; i++) {
      chapters[i].endTimestamp = chapters[i + 1]?.timestamp || Infinity;
    }

    // Generate summary for each chapter
    for (const chapter of chapters) {
      const chapterTranscript = transcript.filter(segment =>
        segment.timestamp >= chapter.timestamp &&
        segment.timestamp < chapter.endTimestamp
      );

      const chapterText = chapterTranscript.map(segment => segment.text).join(' ');

      try {
        const summary = await this.generateSummary(chapterText, `
          Summarize this chapter of a YouTube video titled "${chapter.title}". 
          Focus on the main points and key information. 
          Keep the summary concise but informative.
        `);

        summaries.push({
          chapter: chapter.title,
          timestamp: chapter.rawTime,
          summary
        });
      } catch (error) {
        console.error(`Failed to summarize chapter "${chapter.title}":`, error);
      }
    }

    return {
      type: 'chapter_summaries',
      summaries
    };
  }

  async generateFullSummary(transcript) {
    const fullText = transcript.map(segment => segment.text).join(' ');

    try {
      const summary = await this.generateSummary(fullText, `
        Provide a comprehensive summary of this YouTube video transcript.
        Break down the main topics, key points, and important takeaways.
        Structure the summary in a clear and readable format.
      `);

      return {
        type: 'full_summary',
        summary
      };
    } catch (error) {
      console.error('Failed to generate full summary:', error);
      throw error;
    }
  }

  async generateSummary(text, prompt) {
    try {
      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'phi4',
          prompt: `${prompt}\n\nText to summarize:\n${text}`,
          options: {
            temperature: 0.7,
            num_predict: 1024
          }
        })
      });

      if (!response.ok) {
        throw new Error(`Failed to generate summary: ${response.statusText}`);
      }

      // Get the response as text and split into lines
      const responseText = await response.text();
      const lines = responseText.trim().split('\n');

      // Parse each line as JSON and collect responses
      let fullResponse = '';
      for (const line of lines) {
        try {
          const jsonResponse = JSON.parse(line);
          if (jsonResponse.response) {
            fullResponse += jsonResponse.response;
          }

          // Check for done or error
          if (jsonResponse.done) {
            break;
          }
          if (jsonResponse.error) {
            throw new Error(jsonResponse.error);
          }
        } catch (parseError) {
          console.error('Failed to parse response line:', line, parseError);
        }
      }

      return fullResponse;
    } catch (error) {
      console.error('Summary generation failed:', error);
      console.error('Error details:', {
        message: error.message,
        error: error,
        baseUrl: this.baseUrl
      });
      throw error;
    }
  }

  async getVideoData() {
    try {
      // Wait for video metadata to load
      await this.waitForElement('.ytp-chapter-container');

      const chapters = this.extractChapters();
      const title = document.querySelector('h1.ytd-video-primary-info-renderer')?.textContent?.trim();
      const description = document.querySelector('#description-inline-expander')?.textContent?.trim();

      return {
        title,
        description,
        chapters,
        url: window.location.href,
        videoId: new URLSearchParams(window.location.search).get('v')
      };
    } catch (error) {
      console.error('Failed to get video data:', error);
      return {
        title: document.title,
        videoId: new URLSearchParams(window.location.search).get('v')
      };
    }
  }

  extractChapters() {
    const chapters = [];
    const chapterElements = document.querySelectorAll('.ytp-chapter-container');

    chapterElements.forEach(element => {
      const timeElement = element.querySelector('.ytp-chapter-title-content');
      if (timeElement) {
        const timeText = timeElement.textContent;
        const titleMatch = timeText.match(/^(?:\d+:)*\d+\s+(.+)/);
        if (titleMatch) {
          chapters.push({
            title: titleMatch[1].trim(),
            timestamp: this.timeToSeconds(timeText.split(' ')[0]),
            rawTime: timeText.split(' ')[0]
          });
        }
      }
    });

    return chapters;
  }

  timeToSeconds(timeStr) {
    const parts = timeStr.split(':').map(Number);
    let seconds = 0;
    let multiplier = 1;

    while (parts.length > 0) {
      seconds += (parts.pop() || 0) * multiplier;
      multiplier *= 60;
    }

    return seconds;
  }

  async fetchAutoGeneratedTranscript(videoId) {
    // Direct request to YouTube's transcript API
    const url = `https://www.youtube.com/youtubei/v1/get_transcript?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8`;
    const response = await fetch(url, {
      method: 'POST',
      body: JSON.stringify({
        videoId,
        context: {
          client: {
            clientName: 'WEB',
            clientVersion: '2.20220614.01.00'
          }
        }
      })
    });

    const data = await response.json();
    const transcriptParts = data?.actions?.[0]?.updateEngagementPanelAction?.content?.transcriptRenderer?.content?.transcriptSearchPanelRenderer?.body?.transcriptSegmentListRenderer?.initialSegments || [];

    return transcriptParts.map(part => ({
      text: part.transcriptSegmentRenderer.snippet.runs[0].text,
      timestamp: parseFloat(part.transcriptSegmentRenderer.startTimeText.simpleText)
    }));
  }


  async getTranscript() {
    try {
      // Try to find and click the transcript button if not already open
      const transcriptButton = document.querySelector('[aria-label="Show transcript"]');
      if (transcriptButton) {
        transcriptButton.click();
        // Wait a bit for panel to open
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // Wait for transcript container
      await this.waitForElement('#segments-container');

      // Get all transcript segments
      const transcriptElements = Array.from(document.querySelectorAll('#segments-container ytd-transcript-segment-renderer'));

      if (!transcriptElements.length) {
        console.warn('No transcript elements found');
        return null;
      }

      return transcriptElements.map(element => {
        const timestampEl = element.querySelector('#timestamp');
        const textEl = element.querySelector('#content');

        const timestamp = timestampEl?.textContent?.trim() || '0:00';
        const text = textEl?.textContent?.trim() || '';

        return {
          text,
          timestamp: this.timeToSeconds(timestamp)
        };
      });
    } catch (error) {
      console.error('Failed to extract transcript:', error);
      return null;
    }
  }


  // Updated waitForElement to support iframe document
  async waitForElement(selector, timeout = 5000, context = document) {
    const element = context.querySelector(selector);
    if (element) return element;

    return new Promise((resolve) => {
      const observer = new MutationObserver((_, obs) => {
        const element = context.querySelector(selector);
        if (element) {
          obs.disconnect();
          resolve(element);
        }
      });

      observer.observe(context.body || context.documentElement, {
        childList: true,
        subtree: true
      });

      // Set timeout
      setTimeout(() => {
        observer.disconnect();
        resolve(null);
      }, timeout);
    });
  }

  createResultsContainer() {
    const container = document.createElement('div');
    container.id = 'yt-analyzer-results';
    container.style.cssText = `
      position: fixed;
      top: 70px;
      right: 20px;
      width: 300px;
      max-height: 80vh;
      overflow-y: auto;
      background: white;
      border-radius: 8px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
      padding: 16px;
      z-index: 9999;
    `;
    document.body.appendChild(container);
    return container;
  }

  displayResults(results) {
    let container = document.getElementById('yt-analyzer-results');
    if (!container) {
      container = this.createResultsContainer();
    }

    // Clear previous results
    container.innerHTML = '';

    // Create header container
    const headerContainer = document.createElement('div');
    headerContainer.style.cssText = `
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
      position: relative;
    `;

    // Add title
    const title = document.createElement('h2');
    title.textContent = results.type === 'chapter_summaries' ? 'Chapter Summaries' : 'Video Summary';
    title.style.cssText = 'margin: 0; font-size: 18px; font-weight: bold;';
    headerContainer.appendChild(title);

    // Create dismiss button
    const dismissButton = document.createElement('button');
    dismissButton.textContent = '×';  // Changed from innerHTML to textContent
    dismissButton.style.cssText = `
      position: absolute;
      right: -8px;
      top: -8px;
      background: #f0f0f0;
      border: none;
      color: #666;
      font-size: 20px;
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 50%;
      width: 24px;
      height: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s ease;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    `;

    // Add hover styles
    dismissButton.addEventListener('mouseover', () => {
      dismissButton.style.backgroundColor = '#e0e0e0';
      dismissButton.style.color = '#333';
    });
    dismissButton.addEventListener('mouseout', () => {
      dismissButton.style.backgroundColor = '#f0f0f0';
      dismissButton.style.color = '#666';
    });

    // Add click handler
    dismissButton.addEventListener('click', () => {
      container.remove();
    });

    headerContainer.appendChild(dismissButton);
    container.appendChild(headerContainer);

    // Create content container
    const contentContainer = document.createElement('div');
    contentContainer.style.cssText = 'margin-top: 8px;';

    if (results.type === 'chapter_summaries') {
      results.summaries.forEach(chapter => {
        const chapterDiv = document.createElement('div');
        chapterDiv.style.cssText = 'margin-bottom: 16px;';

        const chapterTitle = document.createElement('h3');
        chapterTitle.textContent = `${chapter.timestamp} - ${chapter.chapter}`;
        chapterTitle.style.cssText = 'margin: 0 0 8px 0; font-size: 14px; font-weight: bold;';

        const summary = document.createElement('p');
        summary.textContent = chapter.summary;
        summary.style.cssText = 'margin: 0; font-size: 14px; line-height: 1.4;';

        chapterDiv.appendChild(chapterTitle);
        chapterDiv.appendChild(summary);
        contentContainer.appendChild(chapterDiv);
      });
    } else {
      const summary = document.createElement('p');
      summary.textContent = results.summary;
      summary.style.cssText = 'margin: 0; font-size: 14px; line-height: 1.4;';
      contentContainer.appendChild(summary);
    }

    container.appendChild(contentContainer);
  }

  displayError(message) {
    let container = document.getElementById('yt-analyzer-results');
    if (!container) {
      container = this.createResultsContainer();
    }

    // Clear previous content
    container.innerHTML = '';

    // Create header with dismiss button
    const headerContainer = document.createElement('div');
    headerContainer.style.cssText = `
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
      position: relative;
    `;

    const title = document.createElement('h3');
    title.textContent = 'Error';
    title.style.cssText = 'margin: 0; color: #d32f2f;';
    headerContainer.appendChild(title);

    const dismissButton = document.createElement('button');
    dismissButton.textContent = '×';
    dismissButton.style.cssText = `
      position: absolute;
      right: -8px;
      top: -8px;
      background: #f0f0f0;
      border: none;
      color: #666;
      font-size: 20px;
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 50%;
      width: 24px;
      height: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s ease;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    `;

    dismissButton.addEventListener('click', () => {
      container.remove();
    });

    headerContainer.appendChild(dismissButton);
    container.appendChild(headerContainer);

    // Add error message and retry button
    const content = document.createElement('div');
    content.innerHTML = `
      <p style="margin: 0 0 12px 0; color: #666;">${message}</p>
      <button id="retry-analysis" style="
        padding: 8px 16px;
        background: #1976d2;
        color: white;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 14px;">
        Retry Analysis
      </button>
    `;
    container.appendChild(content);

    document.getElementById('retry-analysis')?.addEventListener('click', () => {
      this.initializeAnalysis().catch(console.error);
    });
  }

  async waitForElement(selector, timeout = 5000) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(selector)) {
        return resolve(document.querySelector(selector));
      }

      const observer = new MutationObserver((mutations, obs) => {
        const element = document.querySelector(selector);
        if (element) {
          obs.disconnect();
          resolve(element);
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true
      });

      setTimeout(() => {
        observer.disconnect();
        resolve(null);
      }, timeout);
    });
  }

  async analyzeClickbaitAndFluff(videoData, transcript) {
    // Step 1: Generate concise analysis with phi4 using full transcript
    const initialAnalysis = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'phi4',
        prompt: `Analyze this YouTube video comprehensively but write a very concise summary. Keep your final analysis under 500 characters total:
  
  Title: ${videoData.title}
  Description: ${videoData.description}
  Full Transcript: ${transcript.map(segment => segment.text).join(' ')}
  
  Focus only on:
  1. Is the title clickbait or honest?
  2. Estimated percentage of substantial vs filler content
  3. Key issues or misleading elements
  4. 1-2 timestamped sections to skip
  5. Overall value assessment
  
  Keep your response under 500 characters.`,
        options: {
          temperature: 0.7,
          num_predict: 512
        }
      })
    });

    const analysisResponse = await initialAnalysis.text();
    console.log('Initial Analysis:', analysisResponse);

    // Step 2: Convert to structured format using llama3.3
    try {
      // Fetch the structured analysis from the model
      const structuredAnalysis = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'llama3.3',
          prompt: `<s>[INST]Convert this video analysis to JSON format. Output ONLY the JSON object, no other text:
        
        Analysis: ${analysisResponse}
        
        Required JSON structure:
        {
          "clickbaitScore": (number between 0-100),
          "contentValue": (string, one of: "low", "medium", "high"),
          "fluffPercentage": (number between 0-100),
          "keyIssues": (array of strings),
          "skipSections": (array of objects with format {"time": "MM:SS", "reason": "string"}),
          "verdict": (string summary)
        }[/INST]</s>`,
          format: "json",
          options: {
            temperature: 0.1,
            num_predict: 1024
          }
        })
      });

      // Get the raw response text
      const structuredResponseText = await structuredAnalysis.text();
      console.log('Raw Llama Response:', structuredResponseText);


      const lines = structuredResponseText.split('\n');

      let combinedResponse = '';
      for (const line of lines) {
        if (!line.trim()) continue; // skip empty lines

        const jsonData = JSON.parse(line);
        if (jsonData.done === true) {
          break;
        }

        combinedResponse += jsonData.response;
      }

      console.log(combinedResponse);

      // Try to parse the response as JSON directly
      let structuredData = null;

      try {
        const parsedResponse = JSON.parse(combinedResponse);

        // Validate the parsed response has the required structure
        const requiredFields = ['clickbaitScore', 'contentValue', 'fluffPercentage', 'keyIssues', 'skipSections', 'verdict'];
        const missingFields = requiredFields.filter(field => !(field in parsedResponse));

        if (missingFields.length === 0) {
          structuredData = parsedResponse;
        } else {
          console.log('Missing required fields:', missingFields);
        }
      } catch (e) {
        console.log('Failed to parse structured response JSON:', e);
      }

      // If no valid structured data found, throw an error
      if (!structuredData) {
        console.error('Full response text:', structuredResponseText);
        throw new Error('Failed to get valid structured data from model');
      }

      return {
        type: 'content_quality',
        analysis: analysisResponse,
        structured: structuredData
      };

    } catch (error) {
      console.error('Failed to analyze content quality:', error);
      console.error('Error details:', {
        message: error.message,
        name: error.name,
        stack: error.stack
      });
      throw error;
    }
  }

  displayContentQuality(results) {
    let container = document.getElementById('yt-analyzer-results');
    if (!container) {
      container = this.createResultsContainer();
    }

    // Clear previous results
    container.innerHTML = '';

    // Create header with dismiss button
    const headerContainer = document.createElement('div');
    headerContainer.style.cssText = `
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
    position: relative;
  `;

    const title = document.createElement('h2');
    title.textContent = 'Content Quality Analysis';
    title.style.cssText = 'margin: 0; font-size: 18px; font-weight: bold;';
    headerContainer.appendChild(title);

    const dismissButton = document.createElement('button');
    dismissButton.textContent = '×';
    dismissButton.style.cssText = `
    position: absolute;
    right: -8px;
    top: -8px;
    background: #f0f0f0;
    border: none;
    color: #666;
    font-size: 20px;
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 50%;
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s ease;
    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
  `;
    dismissButton.onclick = () => container.remove();
    headerContainer.appendChild(dismissButton);
    container.appendChild(headerContainer);

    // Add quick metrics panel
    const metricsPanel = document.createElement('div');
    metricsPanel.style.cssText = `
    display: flex;
    justify-content: space-between;
    margin-bottom: 16px;
    gap: 8px;
  `;

    const { structured } = results;

    // Helper function for metric badges
    const createMetricBadge = (value, max, label, colorMap) => {
      const badge = document.createElement('div');
      badge.style.cssText = `
      flex: 1;
      background: ${colorMap};
      padding: 8px;
      border-radius: 4px;
      text-align: center;
    `;
      badge.innerHTML = `
      <div style="font-size: 20px; font-weight: bold;">${value}${max ? '/' + max : ''}</div>
      <div style="font-size: 12px; color: #666;">${label}</div>
    `;
      return badge;
    };

    // Add clickbait score
    const clickbaitColor = structured.clickbaitScore > 70 ? '#ffcdd2' :
      structured.clickbaitScore > 30 ? '#fff3e0' : '#c8e6c9';
    metricsPanel.appendChild(createMetricBadge(
      structured.clickbaitScore,
      100,
      'Clickbait Score',
      clickbaitColor
    ));

    // Add content value
    const valueColors = {
      low: '#ffcdd2',
      medium: '#fff3e0',
      high: '#c8e6c9'
    };
    metricsPanel.appendChild(createMetricBadge(
      structured.contentValue.toUpperCase(),
      null,
      'Content Value',
      valueColors[structured.contentValue]
    ));

    // Add fluff percentage
    const fluffColor = structured.fluffPercentage > 50 ? '#ffcdd2' :
      structured.fluffPercentage > 30 ? '#fff3e0' : '#c8e6c9';
    metricsPanel.appendChild(createMetricBadge(
      `${structured.fluffPercentage}%`,
      null,
      'Fluff Content',
      fluffColor
    ));

    container.appendChild(metricsPanel);

    // Add detailed analysis
    /*
    const analysisSection = document.createElement('div');
    analysisSection.style.cssText = 'margin-bottom: 16px; padding: 12px; background: #f5f5f5; border-radius: 4px;';
    analysisSection.textContent = results.analysis;
    container.appendChild(analysisSection);
    */

    // Add key issues if any
    if (structured.keyIssues && structured.keyIssues.length > 0) {
      const issuesContainer = document.createElement('div');
      issuesContainer.style.cssText = 'margin-bottom: 16px;';
      issuesContainer.innerHTML = `
      <h3 style="font-size: 14px; margin: 0 0 8px 0;">Key Issues:</h3>
      <ul style="margin: 0; padding-left: 20px;">
        ${structured.keyIssues.map(issue => `
          <li style="margin-bottom: 4px; font-size: 13px;">${issue}</li>
        `).join('')}
      </ul>
    `;
      container.appendChild(issuesContainer);
    }

    // Add skip sections if any
    if (structured.skipSections && structured.skipSections.length > 0) {
      const skipsContainer = document.createElement('div');
      skipsContainer.innerHTML = '<h3 style="font-size: 14px; margin: 0 0 8px 0;">Sections to Skip:</h3>';

      structured.skipSections.forEach(skip => {
        const skipItem = document.createElement('div');
        skipItem.style.cssText = 'margin-bottom: 8px; font-size: 13px;';
        skipItem.innerHTML = `
        <span style="font-weight: bold;">${skip.time}</span> - ${skip.reason}
      `;
        skipsContainer.appendChild(skipItem);
      });

      container.appendChild(skipsContainer);
    }

    // Add verdict
    const verdictSection = document.createElement('div');
    verdictSection.style.cssText = 'margin-top: 16px; padding: 12px; background: #f5f5f5; border-radius: 4px;';
    verdictSection.innerHTML = `<strong>Verdict:</strong> ${structured.verdict}`;
    container.appendChild(verdictSection);
  }

  // Modify initializeAnalysis method to use new analysis
  async initializeAnalysis() {
    try {
      const videoData = await this.getVideoData();
      const transcript = await this.getTranscript();

      if (!transcript) {
        this.displayError('Transcript not available for this video');
        return;
      }

      const results = await this.analyzeClickbaitAndFluff(videoData, transcript);
      this.displayContentQuality(results);
    } catch (error) {
      console.error('Analysis failed:', error);
      this.displayError(error.message);
    }
  }

  checkForVideoChange() {
    const urlParams = new URLSearchParams(window.location.search);
    const videoId = urlParams.get('v');

    if (videoId && videoId !== this.currentVideoId) {
      this.currentVideoId = videoId;
      // Wait a bit for the page to load
      setTimeout(() => {
        this.initializeAnalysis()
          .catch(error => {
            console.error('Failed to analyze new video:', error);
            this.displayError(error.message);
          });
      }, 2000);
    }
  }

  initialize() {
    // Watch for URL changes
    let lastUrl = location.href;
    new MutationObserver(() => {
      const url = location.href;
      if (url !== lastUrl) {
        lastUrl = url;
        this.checkForVideoChange();
      }
    }).observe(document, { subtree: true, childList: true });

    // Initial check
    this.checkForVideoChange();
  }
}

// Initialize and start the analyzer
const analyzer = new YouTubeAnalyzer();
analyzer.initialize();