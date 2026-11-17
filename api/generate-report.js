const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const groqApiKey = process.env.GROQ_API_KEY;

module.exports = async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Método no permitido' });
    }

    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'No autorizado.' });
        }

        const token = authHeader.split(' ')[1];
        const supabase = createClient(supabaseUrl, supabaseAnonKey, {
            global: { headers: { Authorization: `Bearer ${token}` } }
        });

        const { data: { user }, error: userError } = await supabase.auth.getUser(token);
        if (userError || !user) {
            return res.status(401).json({ error: 'Usuario no autenticado.' });
        }

        // Obtener los registros del diario del usuario
        const { data: logs, error: logError } = await supabase
            .from('daily_log')
            .select('*')
            .eq('user_id', user.id);

        if (logError || !logs || logs.length === 0) {
            return res.status(400).json({ error: 'No hay registros en tu diario de consumo para generar un reporte.' });
        }

        // Calcular promedio de puntuación
        const totalScore = logs.reduce((acc, item) => acc + (item.score || 0), 0);
        const averageScore = Math.round(totalScore / logs.length);

        // Preparar resumen para Groq
        const itemsSummary = logs.map(l => `- ${l.product_name} (Categoría: ${l.category}, Puntuación: ${l.score}/100, Sellos: ${JSON.stringify(l.seals)})`).join('\n');

        const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${groqApiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'qwen/qwen3.8-27b',
                messages: [
                    {
                        role: 'user',
                        content: `Eres un nutriólogo experto. Un usuario ha registrado los siguientes alimentos consumidos hoy:\n${itemsSummary}\nEl puntaje promedio de calidad nutricional es ${averageScore}/100.\n\nGenera EXCLUSIVAMENTE un objeto JSON válido (sin texto extra, sin markdown) con esta estructura:\n{\n  \"diagnosis\": \"Un diagnóstico de 2 o 3 oraciones sobre su consumo actual y el impacto en su salud.\",\n  \"recommendations\": [\n    {\n      \"title\": \"Título de la recomendación (ej. Aumentar consumo de fibra)\",\n      \"detail\": \"Explicación clara de qué le falta y en qué alimentos comunes en México puede encontrarlo.\"\n    }\n  ]\n}`
                    }
                ],
                temperature: 0.3,
                max_tokens: 800
            })
        });

        const groqData = await groqResponse.json();
        if (!groqResponse.ok) {
            throw new Error(groqData.error?.message || 'Error al generar recomendaciones con IA.');
        }

        let rawContent = groqData.choices[0].message.content.trim();
        rawContent = rawContent.replace(/^```json\s*/, '').replace(/^```\s*/, '').replace(/\s*```$/, '');
        const aiReport = JSON.parse(rawContent);

        return res.status(200).json({
            success: true,
            averageScore,
            totalItems: logs.length,
            items: logs,
            aiReport
        });

    } catch (err) {
        console.error('Error generando reporte:', err);
        return res.status(500).json({ error: err.message || 'Error interno al generar el reporte.' });
    }
};
