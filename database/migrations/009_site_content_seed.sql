-- 009_site_content_seed.sql
-- Seeds static_pages, help_topics and testimonials with real starter
-- content so the public site is DB-driven end to end (Joan, Sep 2026:
-- "the website contents are meant to come from the admin, but stored in
-- the DB, make sure its done"). All of it is editable afterwards from
-- the new admin Site Content manager (Pages / Help Topics / Testimonials).
-- Safe to run once; re-running will fail on the unique constraints below
-- (static_pages.slug), which is the correct behaviour for a seed file.

INSERT INTO static_pages (slug, title, content_html) VALUES
('privacy-policy', 'Privacy Policy', '<h2>Housebank''s Privacy Policy</h2>
<p>This Privacy Policy describes Housebank Ink.''s ("we," "us," or "our") collection and use of personal information for our real estate and property-investment services, including our Platform, products, services, websites, and social media accounts ("Services"). This also describes your privacy rights and how you can exercise them.</p>
<p>We may update this Privacy Policy from time to time by posting a new version on our website. The new version will take effect immediately upon posting. We''ll notify you of significant changes by email or through our Services.</p>
<p>"Housebank" refers to Housebank Ink. and its affiliates, service providers and partners whose services may be made available through the Services.</p>
<h2>1. Information we collect</h2>
<p>We collect the following information when you interact with our Services: account information (name, username, email address, phone number, date of birth, profile photo), profile and listing information (photos and descriptions of yourself or your property), identity verification information (government-issued ID, passport, national ID card, or driving licence, where permitted by law), payment information (bank account or card details, to facilitate payments), and geolocation information based on your IP address.</p>
<h2>2. How we collect it</h2>
<p>Information you give us: by filling in forms on our Services, corresponding with us by phone or email, registering to use our Services, making or receiving a booking or payment, completing surveys, or reporting a problem.</p>
<p>Information from third parties: demographic or other information shared with us by third parties, combined with information you provide and information we automatically collect.</p>
<p>Information we automatically collect: usage information (features you use, actions you take), log information (IP address, browser type, access times), and device information (hardware model, operating system, unique identifiers).</p>
<h2>3. Sharing</h2>
<p>We may share your information with other users in limited cases — for example, if you make a booking request, certain information about you is shared with the listing realtor.</p>
<p>We may also share information for business purposes (data analysis, audits, fraud prevention, product development), for legal purposes (to comply with a law or protect the safety of any person), with service providers who perform tasks on our behalf, and in connection with a business transfer such as a merger or acquisition.</p>
<h2>4. Cookies</h2>
<p>Housebank and its partners use cookies and similar technologies to provide and secure our Services and to understand and improve them. We use essential cookies (required to provide the Services), functionality cookies (to remember your choices), and analytics cookies (to understand how our Services are used). You can control cookies through your browser settings.</p>
<h2>5. Marketing communications</h2>
<p>We may send you marketing communications if you have requested information from us or used our Services and have not opted out. You can ask us to stop at any time by following the opt-out link on any marketing message or by contacting us.</p>
<h2>6. Your rights</h2>
<p>You can request access to, correction of, deletion of, or the transfer of your personal information, and you can object to or request restriction of our processing of it. We may need to verify your identity before acting on a request.</p>
<h2>7. Updates to this policy</h2>
<p>We reserve the right to modify this Privacy Policy at any time. When we make changes, we will post the updated policy on this page.</p>
<h2>8. Third-party links</h2>
<p>Our Services may include links to third-party websites, plug-ins and applications. We do not control these third-party sites and are not responsible for their privacy practices.</p>
<h2>9. Contact us</h2>
<p>If you have questions about this Privacy Policy, contact us at support@housebank.com.</p>'),
('anti-discrimination', 'Anti Discrimination', '<h2>Fighting discrimination</h2>
<p>Fighting discrimination and making renting and investment opportunities accessible to everyone is central to how Housebank operates.</p>
<h2>1. Using real data</h2>
<p>We examine how rents and investments are being handled on our platform. Statistical analysis helps us find opportunities to make Housebank accessible to everyone.</p>
<h2>2. Protecting privacy</h2>
<p>We analyze trends in aggregate and don''t associate perceived race, ethnicity, or other protected characteristics with specific people.</p>
<h2>3. Our commitment</h2>
<p>Housebank does not tolerate discrimination on the basis of race, colour, ethnicity, national origin, religion, sex, gender identity, sexual orientation, disability, or age. Realtors and companies found to be in violation of this policy may be suspended or removed from the platform.</p>
<h2>4. Reporting a concern</h2>
<p>If you believe you have experienced or witnessed discrimination on Housebank, please use the Report a Neighbourhood Concern form or contact support@housebank.com.</p>'),
('housebank-cover', 'HouseBank Cover — For Listed Properties', '<p>Every property comes with HouseBank cover for our users. If there''s a serious issue with your rental that your host can''t resolve, we''ll assist in finding you a similar space. Whether you''re searching for a family home, an investment property, or a commercial space, our commitment is to your satisfaction. If any issues arise, your host remains your best point of contact and will likely address the matter quickly — you can also reach out to them directly.</p>
<p>At HouseBank, we''re dedicated to helping you achieve your housing goals with professionalism and care.</p>
<h3>User identity verification</h3>
<p>Our comprehensive verification system checks details such as name, address, and government ID to confirm the identity of every user registered on this platform.</p>
<h3>Renting screening</h3>
<p>Our proprietary technology analyzes hundreds of factors for every user who wants to rent a property, and flags reservations that show a high risk of disruptive activity or property damage.</p>
<h3>Inaccurate listing</h3>
<p>At HouseBank, we''re committed to transparency and trust. That''s why we offer Inaccurate Listing Protection to safeguard your interests.</p>
<p>If a property listing is found to be significantly inaccurate — whether in description, amenities, or condition — we''ll take immediate action. This includes assisting you in finding an alternative property, negotiating compensation, or providing a refund if necessary.</p>
<p>Your confidence in our listings is our priority, and we ensure every step of your real estate journey is met with professionalism and care.</p>
<h3>How Housebank Cover works for rent and investment</h3>
<p>At HouseBank, we''re here to ensure your experience is seamless and stress-free.</p>
<p>Our HouseBank Assurance provides support for serious issues with your property rental — such as your rental being cancelled prior to move-in, the property having fewer rooms than listed, a different type of space being provided, or a major advertised feature (heating, a pool, a kitchen) being unavailable. It doesn''t cover minor inconveniences, like a broken tile.</p>
<h3>What to do if an issue arises</h3>
<p>1. Document the issue — take clear photos or videos of the problem, if possible.</p>
<p>2. Contact your host — reach out within 72 hours of discovering the issue and give them a chance to resolve it.</p>
<p>3. Reach out to us — if the issue doesn''t get resolved or the realtor doesn''t respond, contact HouseBank support as soon as possible.</p>
<p>We''ll review the situation, and if it qualifies under HouseBank Cover, we''ll assist you in finding a similar property, subject to availability at comparable pricing. If a similar property isn''t available or you choose not to re-rent, we''ll provide a full or partial refund.</p>
<p>At HouseBank, your peace of mind is our priority.</p>'),
('housebank-cover-users', 'HouseBank Cover — For Users', '<p>Every property comes with HouseBank cover for our users. If there''s a serious issue with your rental that your host can''t resolve, we''ll assist in finding you a similar space. Whether you''re searching for a family home, an investment property, or a commercial space, our commitment is to your satisfaction. If any issues arise, your host remains your best point of contact and will likely address the matter quickly — you can also reach out to them directly.</p>
<p>At HouseBank, we''re dedicated to helping you achieve your housing goals with professionalism and care.</p>
<h3>Property cancellations</h3>
<p>If a property has already been occupied and you''ve made a payment, our team can help you find a similar place, considering location and amenities, based on availability at comparable pricing. If a similar place isn''t available or you''d prefer not to rent any property, we''ll give you a full refund, including service fees.</p>
<h3>Investment protection</h3>
<p>Our protection ensures that if unforeseen issues arise with your investment — whether a property dispute, title concern, or rental complication — we''ll work diligently to resolve them or compensate you accordingly. With our expertise, your real estate ventures are backed by security and care.</p>
<p>HouseBank is committed to helping you invest with confidence, ensuring your assets are protected every step of the way.</p>
<h3>Inaccurate listing</h3>
<p>At HouseBank, we''re committed to transparency and trust. That''s why we offer Inaccurate Listing Protection to safeguard your interests.</p>
<p>If a property listing is found to be significantly inaccurate — whether in description, amenities, or condition — we''ll take immediate action. This includes assisting you in finding an alternative property, negotiating compensation, or providing a refund if necessary.</p>
<p>Your confidence in our listings is our priority, and we ensure every step of your real estate journey is met with professionalism and care.</p>
<h3>How Housebank Cover works for rent and investment</h3>
<p>At HouseBank, we''re here to ensure your experience is seamless and stress-free.</p>
<p>Our HouseBank Assurance provides support for serious issues with your property rental — such as your rental being cancelled prior to move-in, the property having fewer rooms than listed, a different type of space being provided, or a major advertised feature (heating, a pool, a kitchen) being unavailable. It doesn''t cover minor inconveniences, like a broken tile.</p>
<h3>What to do if an issue arises</h3>
<p>1. Document the issue — take clear photos or videos of the problem, if possible.</p>
<p>2. Contact your host — reach out within 72 hours of discovering the issue and give them a chance to resolve it.</p>
<p>3. Reach out to us — if the issue doesn''t get resolved or the realtor doesn''t respond, contact HouseBank support as soon as possible.</p>
<p>We''ll review the situation, and if it qualifies under HouseBank Cover, we''ll assist you in finding a similar property, subject to availability at comparable pricing. If a similar property isn''t available or you choose not to re-rent, we''ll provide a full or partial refund.</p>
<p>At HouseBank, your peace of mind is our priority.</p>');

INSERT INTO help_topics (category, question, answer, sort_order) VALUES
('Getting started', 'What is HouseBank?', 'HouseBank is a real estate and property-investment marketplace where you can rent, buy, list, and invest in property — directly with verified realtors and registered companies.', 1),
('Getting started', 'How do I create an account?', 'Select "Get Started" on the homepage and choose whether you''re signing up as a customer, a company, or completing a realtor invitation. You''ll need a valid email address and phone number to register.', 2),
('Renting & buying', 'What documents do I need to rent a property?', 'Typically you''ll need a valid ID, proof of income, and references. Requirements can vary by listing, so check the property page or ask the listing realtor directly.', 1),
('Renting & buying', 'Can I negotiate the price?', 'Yes — pricing discussions happen directly between you and the listing realtor or company through the platform''s messaging and viewing-request tools.', 2),
('Payments', 'How do payments work on HouseBank?', 'Payments are made securely through the platform''s supported payment methods. You can add and manage your payment methods from your dashboard''s Payment Methods section.', 1),
('Payments', 'Is my payment information secure?', 'Yes. HouseBank does not store your full card details on its own servers; payments are processed through secure, PCI-compliant payment providers.', 2),
('Investing', 'How does property investment work on HouseBank?', 'Investment opportunities are listed by verified companies and realtors, showing details like minimum investment, expected ROI, and tenure. You can review an opportunity''s details and invest directly from its page once signed in.', 1),
('Trust & safety', 'How do I report a scam or a concerning listing?', 'Use the Report Scam or Report Neighbourhood Concern links in the footer of any page. Reports go directly to our admin team for review.', 1),
('Trust & safety', 'How does HouseBank verify realtors and companies?', 'Companies go through a verification review, and realtors are added to the platform directly by the registered company they work under, or verified independently. Unverified accounts are clearly flagged wherever they appear.', 2);

INSERT INTO testimonials (name, role, rating, quote, is_featured) VALUES
('Sarah O.', 'Home Buyer', 5, 'I can''t thank House Bank Real Estate enough for helping me find my dream home. The process was so smooth, and my realtor was incredibly patient and professional. Highly recommend!', 1),
('Adebayo K.', 'Investor', 5, 'I wanted to invest in real estate but didn''t know where to start. Their investment advisors gave me excellent recommendations, and now I''m seeing great returns on my property. They really know their stuff!', 1),
('James T.', 'Tenant', 5, 'I needed a rental property quickly, and the team at House Bank Real Estate made it happen. They guided me through the listings, organized viewings, and handled the paperwork efficiently. I''m thrilled with my new apartment!', 1);
