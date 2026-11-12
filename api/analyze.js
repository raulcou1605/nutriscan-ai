import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const groqApiKey = process.env.GROQ_API_KEY;

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Método no permitido' });
    }

    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Sesión inválida o expirada. Inicia sesión nuevamente.' });
        }

        const token = authHeader.split(' ')[1];
        
        // Inicializar cliente de Supabase con el token del usuario
        const supabase = createClient(supabaseUrl, supabaseAnonKey, {
            global: { headers: { Authorization: `Bearer ${token}` } }
        });

        // Verificar usuario autenticado
        const { data: { user }, error: userError } = await supabase.auth.getUser(token);
        if (userError || !user) {
            return res.status(401).json({ error: 'Sesión inválida o expirada. Inicia sesión nuevamente.' });
        }

        // Obtener perfil del usuario
        let { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', user.id)
            .single();

        if (profileError || !profile) {
            // Si el perfil no existe, crearlo por defecto
            const { data: newProfile, error: createError } = await supabase
                .from('profiles')
                .insert([{ id: user.id, is_pro: false, scans_today: 0 }])
                .select()
                .single();
            
            if (createError) {
                return res.status(500).json({ error: 'Error al inicializar el perfil de usuario.' });
            }
            profile = newProfile;
        }

        // Si es PRO, pasa directo sin límites
        if (!profile.is_pro) {
            const today = new Date().toISOString().split('T')[0];
            const lastScanDate = profile.last_scan_date ? profile.last_scan_date.split('T')[0] : '';

            let scansToday = profile.scans_today || 0;

            if (lastScanDate !== today) {
                scansToday = 0; // Reiniciar contador si es un nuevo día
            }

            if (scansToday >= 3) {
                return res.status(429).json({ error: 'Límite diario alcanzado', scans_today: scansToday });
            }

            // Incrementar escaneos
            await supabase
                .from('profiles')
                .update({ 
                    scans_today: scansToday + 1, 
                    last_scan_date: new Date().toISOString() 
                })
                .eq('id', user.id);
            
            profile.scans_today = scansToday + 1;
        }

        const { imageBase64, mimeType } = req.body;
        if (!imageBase64) {
            return res.status(400).json({ error: 'No se proporcionó ninguna imagen' });
        }

        // Llamada a la API de Groq para el análisis con IA
        const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${groqApiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'meta-llama/llama-3.2-11b-vision-preview',
                messages: [
                    {
                        role: 'user',
                        content: [
                            {
                                type: 'text',
                                text: `Analiza esta etiqueta o producto alimenticio. Devuelve EXCLUSIVAMENTE un objeto JSON válido (sin texto adicional, sin bloques de código markdown como \`\`\`) con esta estructura exacta:
{
  "name": "Nombre del producto",
  "category": "Categoría (ej. Ultraprocesado, Saludable, Bebida)",
  "categoryClass": "bg-red-100 text-red-800 o bg-emerald-100 text-emerald-800",
  "score": 75,
  "scoreBg": "bg-amber-500",
  "seals": ["Exceso Sodio", "Exceso Azúcares"],
  "harmful": [{"name": "Ingrediente", "damage": "Efecto negativo"}],
  "benefits": [{"text": "Punto favorable"}],
  "summary": "Resumen breve del análisis general."
}`
                            },
                            {
                                type: 'image_url',
                                image_url: {
                                    url: `data:${mimeType || 'image/jpeg'};base64,${imageBase64}`
                                }
                            }
                        ]
                    }
                ],
                temperature: 0.2,
                max_tokens: 1024
            })
        });

        const groqData = await groqResponse.json();
        if (!groqResponse.ok) {
            throw new Error(groqData.error?.message || 'Error al comunicarse con la IA');
        }

        let rawContent = groqData.choices[0].message.content.trim();
        rawContent = rawContent.replace(/^```json\s*/, '').replace(/^```\s*/, '').replace(/\s*```$/, '');
        
        const analysis = JSON.parse(rawContent);

        return res.status(200).json({
            success: true,
            analysis,
            is_pro: profile.is_pro,
            scans_today: profile.scans_today
        });

    } catch (err) {
        console.error('Error en analyze.js:', err);
        return res.status(500).json({ error: err.message || 'Error interno en el servidor' });
    }
}
