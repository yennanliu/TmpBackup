Here is the text extracted from the home assignment document:

## [cite_start]Assignment 1: The "Unified Semantic Inbox" (System Design & Architecture) [cite: 1]
* [cite_start]**Goal**: Test "Large Scale Mindset" and "Data as Infrastructure." [cite: 2]
* [cite_start]**Scenario**: [cite: 3]
    * [cite_start]"We are integrated with LINE and WhatsApp. Build a Stateless Intent Engine that receives webhooks, resolves user identity across platforms, and uses an LLM to decide if the message is a 'Support' issue, a 'Sales' lead, or 'Spam'." [cite: 4]
    * [cite_start]"The system must handle 10,000 concurrent webhooks/sec and store the conversation state in MongoDB such that an Al agent can retrieve the last 5 minutes of context in under 100ms." [cite: 5]
* [cite_start]**Assignment**: [cite: 6]
    1.  [cite_start]**The Architecture**: A diagram showing how they handle the "Thundering Herd" (e.g., using Virtual Threads in Java 21 or Kotlin Coroutines + a Message Queue). [cite: 7]
    2.  [cite_start]**The Schema**: A MongoDB design that uses the Bucket Pattern to prevent document bloating during long chats. [cite: 8]
    3.  [cite_start]**The Al Layer**: How they use Semantic Caching to avoid calling the LLM (OpenAl/Claude) for repetitive "Hello" or "Thank you" messages. [cite: 9]

---

## [cite_start]Assignment 2: The "Self-Correction Pipeline" (Vibe Coding & Startup Execution) [cite: 10]
* [cite_start]**Goal**: Test "Vibe Coding" (speed + Al leverage) and "Startup Mindset" (iterative loops). [cite: 11]
* [cite_start]**Scenario**: [cite: 12]
    * [cite_start]"Build a Live Feedback Loop. Create a service where:" [cite: 13]
    1.  [cite_start]"An Al extracts 'User Sentiment' and 'Product Interest' from a WhatsApp message." [cite: 14]
    2.  [cite_start]"If a human agent manually overrides that sentiment in the system, a MongoDB Change Stream triggers a 'Critic Agent'." [cite: 15]
    3.  [cite_start]"The Critic Agent analyzes why the first Al was wrong and updates a 'Prompt Context' collection to improve future accuracy." [cite: 16]
* [cite_start]**Assignment**: [cite: 17]
    1.  [cite_start]**The Code**: A "Vibe-Coded" repository (they should use Cursor/Windsurf to show speed) that actually runs. [cite: 18]
    2.  [cite_start]**The "Push" Factor**: They must explain how they would deploy this in 24 hours (e.g., "I'd use a Serverless Mongo instance and a simple Ktor wrapper to get the MVP live"). [cite: 19]
    3.  **The Business Logic**: How do they ensure the "Critic Agent" doesn't cost more than the value it provides? (Cost-benefit analysis)[cite_start]. [cite: 20, 21]