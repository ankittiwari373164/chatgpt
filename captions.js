const axios = require("axios");

async function generateCaption(client, prompt) {

    try {

        const response = await axios.post(

            "https://api.groq.com/openai/v1/chat/completions",

            {
                model: "llama-3.3-70b-versatile",

                messages: [

                    {
                        role: "system",

                        content:
                        `
                        You are a luxury social media strategist.

                        Generate:

                        1. Instagram caption
                        2. CTA
                        3. 15 hashtags

                        Return ONLY JSON.
                        `
                    },

                    {
                        role: "user",

                        content:
                        `
                        Brand: ${client}

                        Prompt:
                        ${prompt}
                        `
                    }
                ],

                temperature: 0.8
            },

            {
                headers: {

                    Authorization:
                    `Bearer YOUR_GROQ_API_KEY`,

                    "Content-Type":
                    "application/json"
                }
            }
        );

        const text =
            response.data
            .choices[0]
            .message
            .content;

        return JSON.parse(text);

    } catch (err) {

        console.log(err.message);

        return {

            caption:"",
            cta:"",
            hashtags:[]
        };
    }
}

module.exports = {
    generateCaption
};