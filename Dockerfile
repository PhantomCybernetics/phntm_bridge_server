FROM ubuntu:latest

RUN apt-get update -y --fix-missing
RUN apt-get install -y  ssh \
                        vim mc git \
                        iputils-ping net-tools iproute2 curl 

# Node from NodeSource
RUN apt-get install -y ca-certificates curl gnupg
RUN  mkdir -p /etc/apt/keyrings
RUN curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg

ENV NODE_MAJOR 18
RUN echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list

RUN apt-get update
RUN apt-get install nodejs -y

WORKDIR /

ENV PHNTM_WS /phntm_cloud_bridge

RUN git clone https://github.com/PhantomCybernetics/cloud_bridge.git $PHNTM_WS
RUN cd $PHNTM_WS && npm install

WORKDIR $PHNTM_WS

# pimp up prompt with hostame and color
RUN echo "PS1='\${debian_chroot:+(\$debian_chroot)}\\[\\033[01;35m\\]\\u@\\h\\[\\033[00m\\] \\[\\033[01;34m\\]\\w\\[\\033[00m\\] 🌈 '"  >> /root/.bashrc

CMD [ "bash" ]
